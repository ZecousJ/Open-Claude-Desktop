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
