import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  ExtensionLifecycle,
  registerDesktopExtensionHandlers,
} from "../../electron/connectors/extension-lifecycle";
import { installUnpackedExtension } from "../../electron/connectors/desktop-extension";
import { openPolicy } from "../../shared/client-policy";
import { redactMcpText } from "../../electron/connectors/mcp-connection-logs";
import { mcpServersConfig } from "../../electron/engine/mcp-config";
import { createExtensionReads } from "../../electron/official-ui/native/extensions-read";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b34-extension-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const manifest = {
    name: "demo",
    display_name: "Demo extension",
    description: "Test package",
    version: "1.0",
    author: { name: "Example" },
    user_config: {
      label: { type: "string", title: "Label", required: true },
      token: {
        type: "string",
        title: "Token",
        required: true,
        sensitive: true,
      },
      count: { type: "number", title: "Count", default: 1, min: 0, max: 5 },
    },
    server: {
      mcp_config: {
        command: process.execPath,
        args: ["${__dirname}/server.cjs", "${user_config.label}"],
        env: { TOKEN: "${user_config.token}", COUNT: "${user_config.count}" },
      },
    },
  };
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(source, "server.cjs"),
    "process.stdout.write(JSON.stringify([process.argv[2],process.env.TOKEN,process.env.COUNT]))",
  );
  let servers: Record<string, any> = {};
  let policy = { ...openPolicy };
  let scope = {};
  let encrypted = true;
  let runtime = true;
  let refuseUpdate = false;
  let prepare: (owner: object, id: string) => Promise<void> = async () => {};
  const key = randomBytes(32);
  const cipher = {
    isEncryptionAvailable: () => encrypted,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(value), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decryptString(value: Buffer) {
      const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        c.update(value.subarray(28)),
        c.final(),
      ]).toString();
    },
  };
  const update = (next: Record<string, unknown>) => {
    if (refuseUpdate) throw Error("Synthetic write refusal");
    servers = next;
  };
  installUnpackedExtension({
    source,
    root,
    allowed: () => true,
    current: {},
    update,
  });
  const lifecycle = new ExtensionLifecycle({
    owner: () => ({ root, scope, servers, policy }),
    cipher,
    runtimeConfiguration: () => runtime,
    prepareUninstall: (owner, id) => prepare(owner, id),
    update,
  });
  return {
    root,
    source,
    lifecycle,
    cipher,
    get servers() {
      return servers;
    },
    set servers(next) {
      servers = next;
    },
    set encrypted(value: boolean) {
      encrypted = value;
    },
    set runtime(value: boolean) {
      runtime = value;
    },
    set refuseUpdate(value: boolean) {
      refuseUpdate = value;
    },
    set policy(value: typeof openPolicy) {
      policy = value;
    },
    set scope(value: object) {
      scope = value;
    },
    set prepare(value: (owner: object, id: string) => Promise<void>) {
      prepare = value;
    },
    clean() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const configure = (
  f: ReturnType<typeof fixture>,
  values = { label: "real label", token: "synthetic-secret-123" },
) =>
  f.lifecycle.save({
    id: "demo",
    revision: f.lifecycle.details("demo").revision,
    enabled: true,
    values,
  });

test("pending schema install is disabled; encrypted configuration reaches an actual child process only at runtime", () => {
  const f = fixture();
  try {
    assert.equal(f.servers.demo.enabled, false);
    assert.equal(f.lifecycle.runtimeConfig("demo", f.servers.demo), undefined);
    const saved = configure(f);
    assert.deepEqual(saved.savedSecrets, ["token"]);
    assert.equal(saved.values.token, undefined);
    assert.equal(
      redactMcpText(
        "startup error: synthetic-secret-123",
        f.lifecycle.redactionSecrets(),
      ).includes("synthetic-secret-123"),
      false,
    );
    assert.equal(
      JSON.stringify(f.lifecycle.list()).includes("synthetic-secret-123"),
      false,
    );
    assert.equal(
      JSON.stringify(f.servers).includes("synthetic-secret-123"),
      false,
    );
    for (const file of fs.readdirSync(
      path.join(f.root, "desktop-extension-settings"),
    ))
      assert.equal(
        fs
          .readFileSync(path.join(f.root, "desktop-extension-settings", file))
          .includes(Buffer.from("synthetic-secret-123")),
        false,
      );
    const runtime = f.lifecycle.runtimeConfig("demo", f.servers.demo)!;
    const child = spawnSync(
      runtime.command as string,
      runtime.args as string[],
      { env: { ...process.env, ...(runtime.env as object) }, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [
      "real label",
      "synthetic-secret-123",
      "1",
    ]);
    f.lifecycle.save({
      id: "demo",
      revision: saved.revision,
      enabled: false,
      values: {},
    });
    assert.equal(
      f.lifecycle.runtimeConfig("demo", f.servers.demo),
      undefined,
      "resolver never overrides user disable intent",
    );
    assert.equal(
      fs.readdirSync(path.join(f.root, "desktop-extension-settings")).length,
      2,
      "prior encrypted versions remain available for secondary mirror references",
    );
  } finally {
    f.clean();
  }
});

test("configuration fails closed without actual resolver or OS encryption", () => {
  const f = fixture();
  try {
    f.runtime = false;
    assert.equal(f.lifecycle.details("demo").configurable, false);
    assert.throws(() => configure(f), /unavailable/);
    f.runtime = true;
    f.encrypted = false;
    assert.equal(f.lifecycle.details("demo").configurable, false);
    assert.throws(() => configure(f), /unavailable/);
    assert.equal(
      fs.existsSync(path.join(f.root, "desktop-extension-settings")),
      false,
    );
  } finally {
    f.clean();
  }
});

test("validation and failed MCP publication preserve encrypted settings and prior readiness", () => {
  const f = fixture();
  try {
    assert.throws(() => configure(f, { label: "x", token: "" }), /required/);
    const before = configure(f);
    f.refuseUpdate = true;
    assert.throws(
      () =>
        f.lifecycle.save({
          id: "demo",
          revision: before.revision,
          enabled: false,
          values: { token: "other-secret" },
        }),
      /Synthetic/,
    );
    assert.equal(f.lifecycle.details("demo").revision, before.revision);
    assert.equal(f.servers.demo.enabled, true);
    const runtime = f.lifecycle.runtimeConfig("demo", f.servers.demo)!;
    assert.equal((runtime.env as any).TOKEN, "synthetic-secret-123");
    assert.throws(
      () =>
        f.lifecycle.save({
          id: "demo",
          revision: "0".repeat(64),
          enabled: true,
          values: {},
        }),
      /changed/,
    );
  } finally {
    f.clean();
  }
});

test("uninstall rolls package back on publication failure and removes only owned package/settings on success", async () => {
  const f = fixture();
  try {
    const details = configure(f);
    const directory = f.servers.demo.claudex_extension;
    f.refuseUpdate = true;
    await assert.rejects(
      () => f.lifecycle.uninstall({ id: "demo", revision: details.revision }),
      /Synthetic/,
    );
    assert.ok(fs.existsSync(directory));
    f.refuseUpdate = false;
    await f.lifecycle.uninstall({ id: "demo", revision: details.revision });
    assert.equal(fs.existsSync(directory), false);
    assert.deepEqual(f.servers, {});
    assert.ok(fs.existsSync(f.source));
    assert.deepEqual(
      fs.readdirSync(path.join(f.root, "desktop-extension-settings")),
      [],
    );
  } finally {
    f.clean();
  }
});

test("external paths, package symlinks, aliases, and administrator policy cannot grant lifecycle access", async () => {
  const f = fixture();
  try {
    const entry = f.servers.demo;
    f.servers = { demo: { ...entry, claudex_extension: f.source } };
    assert.equal(f.lifecycle.list()[0].owned, false);
    assert.throws(() => f.lifecycle.details("demo"), /unavailable/);
    f.servers = { demo: entry, alias: { ...entry } };
    assert.equal(
      f.lifecycle.list().find((x) => x.id === "alias")!.owned,
      false,
    );
    await assert.rejects(
      () =>
        f.lifecycle.uninstall({
          id: "demo",
          revision: f.lifecycle.details("demo").revision,
        }),
      /another MCP/,
    );
    f.servers = { demo: entry };
    f.policy = { ...openPolicy, desktopExtensionsEnabled: false };
    const details = f.lifecycle.details("demo");
    assert.equal(details.configurable, false);
    assert.ok(details.blockedReason);
    assert.equal(details.error, undefined);
    assert.equal(details.uninstallable, false);
    await assert.rejects(
      () => f.lifecycle.uninstall({ id: "demo", revision: details.revision }),
      /unavailable/,
    );
    f.policy = { ...openPolicy };
    fs.rmSync(entry.claudex_extension, { recursive: true });
    fs.symlinkSync(f.source, entry.claudex_extension);
    assert.equal(f.lifecycle.list()[0].owned, false);
    assert.ok(fs.existsSync(path.join(f.source, "server.cjs")));
  } finally {
    f.clean();
  }
});

test("encrypted corruption and settings symlinks never fall back to plaintext or defaults", async () => {
  const f = fixture();
  try {
    configure(f);
    const folder = path.join(f.root, "desktop-extension-settings");
    const file = path.join(folder, fs.readdirSync(folder)[0]);
    fs.writeFileSync(file, "broken ciphertext");
    assert.equal(f.lifecycle.details("demo").configurable, false);
    assert.ok(f.lifecycle.details("demo").error);
    f.policy = { ...openPolicy, desktopExtensionsEnabled: false };
    assert.ok(f.lifecycle.details("demo").error);
    f.policy = { ...openPolicy };
    assert.throws(() => f.lifecycle.runtimeConfig("demo", f.servers.demo));
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.source, "manifest.json"), file);
    const readonly = f.lifecycle.details("demo");
    assert.equal(readonly.configurable, false);
    await f.lifecycle.uninstall({ id: "demo", revision: readonly.revision });
    assert.ok(
      fs.existsSync(path.join(f.source, "manifest.json")),
      "settings link target is never removed",
    );
  } finally {
    f.clean();
  }
});

test("read-only policy retains the real installed extension inventory", async () => {
  const f = fixture();
  try {
    configure(f);
    const policy = { ...openPolicy, localMcpEditing: false };
    f.policy = policy;
    const reads = createExtensionReads({
      account: () => ({ id: "owner" }),
      sessionIdentity: () => "owner",
      settings: () => ({ mcpServers: f.servers }),
      call: async (name: string, id: string) => {
        if (name === "desktopExtensions") return f.lifecycle.list();
        if (name === "desktopExtension") return f.lifecycle.details(id);
        if (name === "clientPolicy") return policy;
        throw Error("unexpected call");
      },
    } as never);
    const [extension] = await reads.installed();
    assert.equal(extension.id, "demo");
    assert.equal(extension.settings.isEnabled, true);
    assert.equal(extension.settings.orgBlockedReason, undefined);
    assert.equal(extension.settings.userConfig.label, "real label");
    assert.equal(extension.settings.userConfig.token, undefined);
    const folder = path.join(f.root, "desktop-extension-settings");
    fs.writeFileSync(path.join(folder, fs.readdirSync(folder)[0]), "broken ciphertext");
    await assert.rejects(reads.installed(), /could not be read/);
  } finally {
    f.clean();
  }
});

test("actual registered handlers validate IDs and accept revision-protected lifecycle calls", async () => {
  const f = fixture();
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerDesktopExtensionHandlers(
      (name, fn) => handlers.set(name, fn),
      f.lifecycle,
    );
    assert.equal(
      handlers.get("desktopExtensions")!()[0].name,
      "Demo extension",
    );
    assert.throws(() => handlers.get("desktopExtension")!("../outside"));
    const current = handlers.get("desktopExtension")!("demo");
    const saved = handlers.get("saveDesktopExtension")!({
      id: "demo",
      revision: current.revision,
      enabled: true,
      values: { label: "demo", token: "secret" },
    });
    assert.equal(saved.values.token, undefined);
    await assert.rejects(
      () =>
        handlers.get("uninstallDesktopExtension")!({
          id: "demo",
          revision: current.revision,
        }),
      /changed/,
    );
  } finally {
    f.clean();
  }
});

test("missing version files and copied ciphertext cannot authorize another package/account", () => {
  const f = fixture();
  const other = fixture();
  try {
    configure(f);
    const folder = path.join(f.root, "desktop-extension-settings");
    const saved = path.join(folder, fs.readdirSync(folder)[0]);
    const encrypted = fs.readFileSync(saved);
    fs.unlinkSync(saved);
    assert.throws(
      () => f.lifecycle.runtimeConfig("demo", f.servers.demo),
      /unavailable/,
    );
    // Even valid OS-decrypted bytes carry the originating account/package binding.
    const plain = f.cipher.decryptString(encrypted);
    other.lifecycle.save({
      id: "demo",
      revision: other.lifecycle.details("demo").revision,
      enabled: true,
      values: { label: "Other", token: "other-secret" },
    });
    const otherFolder = path.join(other.root, "desktop-extension-settings");
    fs.writeFileSync(
      path.join(otherFolder, fs.readdirSync(otherFolder)[0]),
      other.cipher.encryptString(plain),
    );
    assert.equal(other.lifecycle.details("demo").configurable, false);
    assert.throws(
      () => other.lifecycle.runtimeConfig("demo", other.servers.demo),
      /unavailable/,
    );
  } finally {
    f.clean();
    other.clean();
  }
});

test("account retirement during encryption refuses publication and removes only its new version", () => {
  const f = fixture();
  try {
    const before = f.lifecycle.details("demo");
    const encrypt = f.cipher.encryptString;
    f.cipher.encryptString = (value) => {
      const encrypted = encrypt(value);
      f.scope = {};
      return encrypted;
    };
    assert.throws(
      () =>
        f.lifecycle.save({
          id: "demo",
          revision: before.revision,
          enabled: true,
          values: { label: "x", token: "secret" },
        }),
      /changed/,
    );
    assert.equal(f.servers.demo.enabled, false);
    assert.deepEqual(
      fs.readdirSync(path.join(f.root, "desktop-extension-settings")),
      [],
    );
  } finally {
    f.clean();
  }
});

test("mounted production Extensions tab uses registered lifecycle handlers through configure and uninstall", async () => {
  const f = fixture();
  const { createElement: h } = await import("react");
  const { routineDom } = await import("../support/routine-dom");
  const { ExtensionsTab } = await import("../../src/settings/tabs/Extensions");
  const { HostContext } = await import("../../src/host/HostContext");
  const { desktopHost } = await import("../../shared/host");
  const { defaultSettings } = await import("../../electron/store/store");
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  registerDesktopExtensionHandlers((name, fn) => {
    handlers[name] = fn;
  }, f.lifecycle);
  const env = await routineDom(
    Object.fromEntries(
      Object.entries(handlers).map(([name, fn]) => [
        name,
        async (...args: any[]) => fn(...args),
      ]),
    ) as never,
    { jsdom: true },
  );
  const saved = new Map(
    [
      "innerWidth",
      "innerHeight",
      "addEventListener",
      "removeEventListener",
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const globals = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const button = (name: string) =>
    [...env.document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === name,
    )!;
  try {
    await env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(ExtensionsTab, {
          settings: { ...defaultSettings, mcpServers: f.servers },
          save() {},
          goTo() {},
          onError(error: unknown) {
            throw error;
          },
        } as never),
      ),
    );
    // Let React finish the actual lazy import; no source substitution.
    const { act } = await import("react");
    await act(async () => {
      await import("../../src/settings/tabs/InstalledExtensions");
    });
    await env.event(button("Configure"), "click");
    await env.change('[aria-label="Label"]', "From mounted UI");
    await env.change('[aria-label="Token"]', "mounted-secret");
    await env.event(
      env.document.querySelector('[role="switch"][aria-label="Enabled"]')!,
      "click",
    );
    await env.event(env.document.querySelector("form")!, "submit");
    const config = f.lifecycle.runtimeConfig("demo", f.servers.demo)!;
    assert.equal((config.env as any).TOKEN, "mounted-secret");
    assert.equal(JSON.stringify(f.servers).includes("mounted-secret"), false);
    const secretInput = env.document.querySelector('[aria-label="Token"]');
    assert.equal(
      secretInput,
      null,
      "successful save returns to read-only metadata",
    );
    await env.event(button("Uninstall"), "click");
    await env.event(button("Uninstall"), "click");
    assert.deepEqual(f.servers, {});
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await env.clean();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    f.clean();
  }
});

test("owned package with a broken manifest remains removable without reading outside its package", async () => {
  const f = fixture();
  try {
    const directory = f.servers.demo.claudex_extension;
    fs.unlinkSync(path.join(directory, "manifest.json"));
    fs.symlinkSync(
      path.join(f.source, "manifest.json"),
      path.join(directory, "manifest.json"),
    );
    const details = f.lifecycle.details("demo");
    assert.equal(
      details.name,
      "demo",
      "no metadata is read through the symlink",
    );
    assert.equal(details.configurable, false);
    assert.equal(details.uninstallable, true);
    await f.lifecycle.uninstall({ id: "demo", revision: details.revision });
    assert.ok(fs.existsSync(path.join(f.source, "manifest.json")));
  } finally {
    f.clean();
  }
});

test("uninstall requires a real quiescence hook and refuses when runtime preparation fails", async () => {
  const f = fixture();
  try {
    const scope = {};
    const unsupported = new ExtensionLifecycle({
      owner: () => ({
        root: f.root,
        scope,
        servers: f.servers,
        policy: openPolicy,
      }),
      cipher: f.cipher,
      runtimeConfiguration: () => true,
      update: () => {},
    });
    const unavailable = unsupported.details("demo");
    assert.equal(unavailable.uninstallable, false);
    await assert.rejects(
      () =>
        unsupported.uninstall({ id: "demo", revision: unavailable.revision }),
      /unavailable/,
    );
    const directory = f.servers.demo.claudex_extension;
    f.prepare = async () => {
      assert.ok(fs.existsSync(directory));
      assert.ok(f.servers.demo);
      throw Error("Actual runtime is busy");
    };
    await assert.rejects(
      () =>
        f.lifecycle.uninstall({
          id: "demo",
          revision: f.lifecycle.details("demo").revision,
        }),
      /busy/,
    );
    assert.ok(fs.existsSync(directory));
    assert.ok(f.servers.demo);
  } finally {
    f.clean();
  }
});

test("uninstall suppresses respawn during quiescence and rechecks account lease after awaited stop", async () => {
  const f = fixture();
  try {
    const details = configure(f);
    const directory = f.servers.demo.claudex_extension;
    let stopped!: () => void;
    f.prepare = () =>
      new Promise((resolve) => {
        stopped = resolve;
      });
    const work = f.lifecycle.uninstall({
      id: "demo",
      revision: details.revision,
    });
    assert.equal(f.lifecycle.runtimeConfig("demo", f.servers.demo), undefined);
    assert.ok(fs.existsSync(directory));
    f.scope = {};
    stopped();
    await assert.rejects(work, /changed/);
    assert.ok(fs.existsSync(directory));
    assert.ok(f.servers.demo);
    assert.ok(f.lifecycle.runtimeConfig("demo", f.servers.demo));
  } finally {
    f.clean();
  }
});

test("upgrading an owned package preserves encrypted settings and rolls back a refused publication", () => {
  const f = fixture();
  try {
    configure(f);
    const before = f.lifecycle.details("demo");
    const manifestPath = path.join(f.source, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "2.0";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(f.source, "server.cjs"),
      "process.stdout.write('version-2')",
    );
    const perform = () =>
      installUnpackedExtension({
        source: f.source,
        root: f.root,
        allowed: () => true,
        current: f.servers,
        update: (value) => {
          f.servers = value;
        },
        prepareUpgrade: (id, next, target) => f.lifecycle.prepareUpgrade(id, next, target),
      });
    const previousUpdate = f.lifecycle.options.update;
    assert.equal(perform(), "demo");
    const after = f.lifecycle.details("demo");
    assert.equal(after.version, "2.0");
    assert.deepEqual(after.savedSecrets, before.savedSecrets);
    assert.equal(after.values.label, "real label");
    const expanded = f.lifecycle.runtimeConfig("demo", f.servers.demo);
    assert.equal(
      (expanded?.env as Record<string, string>).TOKEN,
      "synthetic-secret-123",
    );
    manifest.version = "3.0";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () =>
        installUnpackedExtension({
          source: f.source,
          root: f.root,
          allowed: () => true,
          current: f.servers,
          prepareUpgrade: (id, next, target) => f.lifecycle.prepareUpgrade(id, next, target),
          update: () => {
            throw Error("Synthetic write refusal");
          },
        }),
      /Synthetic write refusal/,
    );
    assert.equal(f.lifecycle.details("demo").version, "2.0");
    assert.equal(
      f.lifecycle.runtimeConfig("demo", f.servers.demo)?.env &&
        (
          f.lifecycle.runtimeConfig("demo", f.servers.demo)!.env as Record<
            string,
            string
          >
        ).TOKEN,
      "synthetic-secret-123",
    );
    assert.equal(f.lifecycle.options.update, previousUpdate);
  } finally {
    f.clean();
  }
});

test("upgrade migrates compatible values and keeps new required fields pending without exposing removed secrets", () => {
  const f = fixture();
  try {
    configure(f);
    const manifestPath = path.join(f.source, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "2.0";
    manifest.user_config = {
      label: { type: "string", title: "Label", required: true },
      token: {
        type: "string",
        title: "Token",
        required: true,
        sensitive: false,
      },
      region: { type: "string", title: "Region", required: true },
    };
    manifest.server.mcp_config.env = { TOKEN: "${user_config.token}" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const install = (update: (value: Record<string, unknown>) => void) =>
      installUnpackedExtension({
        source: f.source,
        root: f.root,
        allowed: () => true,
        current: f.servers,
        update,
        prepareUpgrade: (id, next, target) => f.lifecycle.prepareUpgrade(id, next, target),
      });
    const settingsDir = path.join(f.root, "desktop-extension-settings");
    const beforeFiles = fs.readdirSync(settingsDir).sort();
    assert.throws(
      () =>
        install(() => {
          throw Error("save refused");
        }),
      /save refused/,
    );
    assert.deepEqual(fs.readdirSync(settingsDir).sort(), beforeFiles);
    assert.equal(f.lifecycle.details("demo").version, "1.0");
    assert.equal(
      install((value) => {
        f.servers = value;
      }),
      "demo",
    );
    const result = f.lifecycle.details("demo");
    assert.equal(result.version, "2.0");
    assert.equal(result.enabled, false);
    assert.equal(result.values.label, "real label");
    assert.equal(result.values.token, undefined);
    assert.equal(result.savedSecrets.includes("token"), false);
    assert.equal(
      JSON.stringify(result).includes("synthetic-secret-123"),
      false,
    );
    const completed = f.lifecycle.save({
      id: "demo",
      revision: result.revision,
      enabled: true,
      values: { token: "replacement", region: "east" },
    });
    assert.equal(completed.enabled, true);
    assert.equal(completed.values.token, "replacement");
    assert.equal(completed.values.region, "east");
  } finally {
    f.clean();
  }
});

test("official file and directory settings expand multiple paths into separate arguments", () => {
  const f = fixture();
  try {
    const file = path.join(f.source, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.version = "2.0";
    manifest.user_config = {
      folders: {
        type: "directory",
        title: "Folders",
        required: true,
        multiple: true,
      },
      file: { type: "file", title: "File", required: true },
    };
    manifest.server.mcp_config = {
      command: "unselected",
      args: ["${user_config.folders}"],
      env: { BASE: "base" },
      platform_overrides: {
        [process.platform]: {
          command: process.execPath,
          args: [
            "${__dirname}/server.cjs",
            "${user_config.folders}",
            "${user_config.file}",
            "${/}",
          ],
          env: { OVERRIDE: "yes" },
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(manifest));
    installUnpackedExtension({
      source: f.source,
      root: f.root,
      allowed: () => true,
      current: f.servers,
      update: (value) => {
        f.servers = value;
      },
      prepareUpgrade: (id, next, target) => f.lifecycle.prepareUpgrade(id, next, target),
    });
    const details = f.lifecycle.details("demo");
    assert.equal(details.enabled, false);
    assert.throws(
      () =>
        f.lifecycle.save({
          id: "demo",
          revision: details.revision,
          enabled: true,
          values: { folders: [], file: "/one" },
        }),
      /required/,
    );
    const saved = f.lifecycle.save({
      id: "demo",
      revision: details.revision,
      enabled: true,
      values: { folders: ["/first", "/second"], file: "/selected.txt" },
    });
    assert.deepEqual(saved.values.folders, ["/first", "/second"]);
    const runtime = f.lifecycle.runtimeConfig("demo", f.servers.demo);
    assert.equal(runtime?.command, process.execPath);
    assert.deepEqual((runtime?.args as string[]).slice(1), [
      "/first",
      "/second",
      "/selected.txt",
      path.sep,
    ]);
    assert.deepEqual(runtime?.env, { BASE: "base", OVERRIDE: "yes" });
  } finally {
    f.clean();
  }
});

test("missing extension variables cannot become literal undefined arguments", () => {
  const f = fixture();
  try {
    const manifest = { server: { mcp_config: { command: process.execPath, args: ["${user_config.optional}"] } } };
    assert.throws(() => f.lifecycle.expanded(f.source, manifest, {}));
    manifest.server.mcp_config.args = ["${unknown}"];
    assert.throws(() => f.lifecycle.expanded(f.source, manifest, {}));
  } finally {
    f.clean();
  }
});

test("official system directory variables resolve for extensions without configuration", () => {
  const f = fixture();
  try {
    const sourceManifest = path.join(f.source, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
    delete manifest.user_config;
    manifest.server.mcp_config = {
      command: process.execPath,
      args: ["${HOME}", "${DESKTOP}", "${DOCUMENTS}", "${DOWNLOADS}", "${/}"],
    };
    fs.writeFileSync(sourceManifest, JSON.stringify(manifest));
    const dirs = {
      HOME: "/home/user",
      DESKTOP: "/home/user/Desktop",
      DOCUMENTS: "/home/user/Documents",
      DOWNLOADS: "/home/user/Downloads",
    };
    f.lifecycle.options.systemDirs = () => dirs;
    installUnpackedExtension({
      source: f.source,
      root: f.root,
      allowed: () => true,
      current: f.servers,
      update: (value) => {
        f.servers = value;
      },
      prepareUpgrade: (id, next, target) => f.lifecycle.prepareUpgrade(id, next, target),
    });
    const runtime = f.lifecycle.runtimeConfig("demo", f.servers.demo);
    assert.deepEqual(runtime?.args, [
      dirs.HOME,
      dirs.DESKTOP,
      dirs.DOCUMENTS,
      dirs.DOWNLOADS,
      path.sep,
    ]);
  } finally {
    f.clean();
  }
});

test("UV extension runtime uses its selected executable and package directory without leaking internal metadata", () => {
  const f = fixture();
  try {
    const file = path.join(f.source, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.version = "2.0";
    delete manifest.user_config;
    manifest.server.type = "uv";
    manifest.server.mcp_config = { command: "uv", args: ["run", "server.py"] };
    fs.writeFileSync(file, JSON.stringify(manifest));
    const name = installUnpackedExtension({
      source: f.source, root: f.root, sourceKind: "local.mcpb", uvExecutable: process.execPath,
      allowed: () => true, current: f.servers, update: value => { f.servers = value; },
      prepareUpgrade: (id, next, target) => f.lifecycle.prepareUpgrade(id, next, target),
    });
    const server = f.servers[name] as Record<string, unknown>;
    const runtime = f.lifecycle.runtimeConfig(name, server);
    assert.equal(runtime?.command, process.execPath);
    assert.equal(runtime?.cwd, server.claudex_extension);
    const config = JSON.parse(mcpServersConfig({
      servers: f.servers, policy: openPolicy, reserved: new Set(), environmentKind: "local",
      remote: false, runtimeConfig: (id, raw) => f.lifecycle.runtimeConfig(id, raw),
      launchConfig: (_id, entry) => entry, serviceScript: "/tmp/service.cjs", builtInNode: false,
    }))[name];
    assert.equal(config.command, process.execPath);
    assert.equal(config.cwd, server.claudex_extension);
    assert.equal(config.claudex_extension_id, undefined);
    assert.equal(config.claudex_extension_manifest_name, undefined);
    assert.equal(config.claudex_extension_uv, undefined);
  } finally { f.clean(); }
});
