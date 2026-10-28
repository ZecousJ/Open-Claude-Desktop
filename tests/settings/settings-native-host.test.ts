import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { buildSync } from "esbuild";
import { NativeExtensionHost } from "../../electron/connectors/native-extension-host";
import { installUnpackedExtension } from "../../electron/connectors/desktop-extension";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import type { AppContext } from "../../electron/app/app-context";

async function fixture(t: test.TestContext, electron = false) {
  const executable = electron
    ? (createRequire(import.meta.url)("electron") as string)
    : process.execPath;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b34-native-host-"),
  );
  const helper = path.join(root, "mcp-stdio-wrapper.cjs");
  buildSync({
    entryPoints: ["server/mcp-stdio-wrapper.ts"],
    outfile: helper,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const store = new Store(root);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify({
      name: "demo",
      display_name: "Synthetic extension",
      version: "1.0",
      user_config: {
        token: { type: "string", required: true, sensitive: true },
      },
      server: {
        mcp_config: {
          command: electron ? "node" : process.execPath,
          args: ["${__dirname}/server.cjs"],
          env: { PRIVATE: "${user_config.token}" },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(source, "server.cjs"),
    "process.stdout.write(process.env.PRIVATE);process.stderr.write('startup '+process.env.PRIVATE+'\\n')",
  );
  installUnpackedExtension({
    source,
    root,
    current: {},
    allowed: () => true,
    update: (servers) => (store.settings.mcpServers = servers),
  });
  let deactivate = () => {};
  const context = {
    store,
    engine,
    activeAccount: { id: "synthetic-account" },
    remote: undefined,
    engines: { all: () => [engine], isBusy: () => engine.ownBusy() },
    policy: () => openPolicy,
    settingsChanged() {},
    onAccountDeactivating(callback: () => void) {
      deactivate = callback;
      return () => {};
    },
  };
  const key = randomBytes(32);
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([c.update(text), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), bytes]);
    },
    decryptString(bytes: Buffer) {
      const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      c.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        c.update(bytes.subarray(28)),
        c.final(),
      ]).toString();
    },
  };
  const host = new NativeExtensionHost({
    ctx: context as unknown as AppContext,
    cipher,
    helperPath: helper,
    node: { executable, electron },
  });
  await host.activate();
  const handlers = new Map<string, (...args: any[]) => any>();
  host.register((name, fn) => handlers.set(name, fn));
  t.after(async () => {
    host.retire();
    await engine.stop();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    cipher,
    host,
    store,
    engine,
    context,
    deactivate: () => deactivate(),
    invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
  };
}

for (const electron of [false, true])
  test(`registered native Configure launches exact bytes through the actual ${electron ? "Electron built-in Node" : "Node"} private wrapper`, async (t) => {
    const env = await fixture(t, electron);
    const detail = env.invoke("desktopExtension", "demo");
    assert.equal(detail.configurable, true);
    assert.equal(detail.enabled, false);
    const secret = "synthetic-native-private-token";
    const saved = env.invoke("saveDesktopExtension", {
      id: "demo",
      revision: detail.revision,
      enabled: true,
      values: { token: secret },
    });
    assert.deepEqual(saved.savedSecrets, ["token"]);
    assert.equal(saved.values.token, undefined);
    const config = JSON.parse((env.engine as any).mcpConfig()).demo;
    assert.ok(config);
    assert.ok(!JSON.stringify(config).includes(secret));
    assert.ok(
      !fs
        .readFileSync(path.join(env.root, "settings.json"), "utf8")
        .includes(secret),
    );
    for (const file of fs.readdirSync(
      path.join(env.root, "desktop-extension-settings"),
    ))
      assert.ok(
        !fs
          .readFileSync(path.join(env.root, "desktop-extension-settings", file))
          .includes(Buffer.from(secret)),
      );
    const child = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => (stdout += bytes));
    child.stderr.on("data", (bytes) => (stderr += bytes));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, secret);
    assert.ok(!stderr.includes(secret));
    const logs = env.host.read("demo")!;
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.match(JSON.stringify(logs), /redacted/);
  });

test("native uninstall waits for actual engine shutdown while blocking new sends, then removes only its owned package", async (t) => {
  const env = await fixture(t);
  const detail = env.invoke("desktopExtension", "demo");
  let release!: () => void;
  let began!: () => void;
  const entered = new Promise<void>((resolve) => (began = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  env.engine.rpc = {
    async stop() {
      began();
      await gate;
    },
  } as never;
  const removal = env.invoke("uninstallDesktopExtension", {
    id: "demo",
    revision: detail.revision,
  });
  await entered;
  assert.ok(env.store.settings.mcpServers.demo);
  await assert.rejects(
    env.engine.ensure(env.store.settings.providers[0]),
    /maintenance/,
  );
  release();
  await removal;
  assert.equal(env.store.settings.mcpServers.demo, undefined);
  assert.ok(fs.existsSync(path.join(env.root, "source", "manifest.json")));
  assert.equal(env.engine.mcpMaintenance?.(), false);
});

test("failed durable native saves retain prior pointers; sign-out retires handlers and capture synchronously", async (t) => {
  const env = await fixture(t);
  const detail = env.invoke("desktopExtension", "demo");
  const previous = structuredClone(env.store.settings.mcpServers);
  env.store.write = () => {
    throw Error("Synthetic durable save failure");
  };
  assert.throws(
    () =>
      env.invoke("saveDesktopExtension", {
        id: "demo",
        revision: detail.revision,
        enabled: true,
        values: { token: "synthetic" },
      }),
    /durable save failure/,
  );
  assert.deepEqual(env.store.settings.mcpServers, previous);
  assert.deepEqual(
    fs.readdirSync(path.join(env.root, "desktop-extension-settings")),
    [],
  );
  // Restore the real writer for cleanup; retirement happens before any await.
  env.store.write = Store.prototype.write.bind(env.store);
  env.deactivate();
  assert.throws(() => env.invoke("desktopExtension", "demo"), /unavailable/);
  assert.equal(env.engine.mcpMaintenance?.(), true);
});

test("corrupt or locked protected configuration cannot prevent an unrelated real Engine server from starting", async (t) => {
  const env = await fixture(t);
  const detail = env.invoke("desktopExtension", "demo");
  env.invoke("saveDesktopExtension", {
    id: "demo",
    revision: detail.revision,
    enabled: false,
    values: { token: "private" },
  });
  for (const file of fs.readdirSync(
    path.join(env.root, "desktop-extension-settings"),
  ))
    fs.writeFileSync(
      path.join(env.root, "desktop-extension-settings", file),
      "corrupt ciphertext",
    );
  env.store.settings.mcpServers.ordinary = {
    command: process.execPath,
    args: ["ordinary.cjs"],
  };
  for (const enabled of [false, true]) {
    (env.store.settings.mcpServers.demo as Record<string, unknown>).enabled =
      enabled;
    const config = JSON.parse((env.engine as any).mcpConfig());
    assert.ok(config.ordinary);
    assert.equal(config.demo, undefined);
  }
  env.cipher.isEncryptionAvailable = () => false;
  env.cipher.decryptString = () => {
    throw Error("Native keychain locked");
  };
  assert.ok(JSON.parse((env.engine as any).mcpConfig()).ordinary);
  assert.equal(env.invoke("desktopExtension", "demo").configurable, false);
});

test("changing another extension secret does not retire an unchanged server or give its bootstrap the other credential", async (t) => {
  const env = await fixture(t);
  const save = (id: string, token: string) => {
    const detail = env.invoke("desktopExtension", id);
    env.invoke("saveDesktopExtension", {
      id,
      revision: detail.revision,
      enabled: true,
      values: { token },
    });
  };
  save("demo", "first-private-token");
  const original = JSON.parse((env.engine as any).mcpConfig()).demo;
  const source = path.join(env.root, "second-source");
  fs.mkdirSync(source);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(env.source, "manifest.json"), "utf8"),
  );
  manifest.name = "other";
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify(manifest),
  );
  fs.copyFileSync(
    path.join(env.source, "server.cjs"),
    path.join(source, "server.cjs"),
  );
  installUnpackedExtension({
    source,
    root: env.root,
    current: env.store.settings.mcpServers,
    allowed: () => true,
    update: (servers) => (env.store.settings.mcpServers = servers),
  });
  save("other", "unrelated-private-token");
  const current = JSON.parse((env.engine as any).mcpConfig());
  assert.deepEqual(current.demo, original);
  assert.ok(current.other);
});
