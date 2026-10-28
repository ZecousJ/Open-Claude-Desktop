import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b34-native-engine-"),
  );
  const store = new Store(root);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    engine,
    config: () => JSON.parse((engine as any).mcpConfig()),
  };
}

test("protected extension configuration never falls back to unresolved or expanded persisted entries", (t) => {
  const { store, engine, config } = fixture(t);
  store.settings.mcpServers = {
    protected: {
      command: "node",
      args: ["${user_config.token}"],
      claudex_extension: "/owned",
      claudex_extension_settings: "encrypted-version",
    },
    ordinary: { command: "node", args: ["ordinary.js"] },
  };
  assert.equal(config().protected, undefined);
  engine.mcpRuntimeConfig = (name, entry) =>
    name === "protected" ? undefined : entry;
  assert.equal(config().protected, undefined);
  assert.equal(config().ordinary.command, "node");
  engine.mcpRuntimeConfig = (name, entry) =>
    name === "protected"
      ? {
          ...entry,
          args: ["decrypted-secret"],
          env: { KEY: "decrypted-secret" },
        }
      : entry;
  engine.mcpLaunchConfig = (name, entry) =>
    name === "protected"
      ? {
          command: process.execPath,
          args: ["private-wrapper.cjs"],
          env: { CAPABILITY: "opaque" },
        }
      : entry;
  const persisted = JSON.stringify(config());
  assert.ok(!persisted.includes("decrypted-secret"));
  assert.ok(!persisted.includes("${user_config"));
  assert.ok(!persisted.includes("claudex_extension"));
});

test("private launch hook receives the actual bundled Node rewrite and cannot resurrect a dropped entry", (t) => {
  const { store, engine, config } = fixture(t);
  store.settings.mcpServers = {
    demo: {
      command: "node",
      env: { ORIGINAL: "yes" },
      claudex_extension: "/owned",
    },
  };
  let received: Record<string, unknown> | undefined;
  engine.mcpLaunchConfig = (_, entry) => {
    received = entry;
    return undefined;
  };
  assert.deepEqual(config(), {});
  assert.equal(received?.command, process.execPath);
  assert.deepEqual(received?.env, {
    ORIGINAL: "yes",
    ELECTRON_RUN_AS_NODE: "1",
  });
});

test("native extension resolution is never forwarded to another execution environment", (t) => {
  const { store, engine } = fixture(t);
  store.settings.mcpServers = {
    demo: {
      command: "node",
      claudex_extension: "/owned",
      claudex_extension_settings: "encrypted-version",
    },
  };
  for (const environment of [
    { kind: "ssh", hostId: "remote" },
    { kind: "space", spaceId: "cloud" },
  ] as const) {
    const peer = engine.createPeer({ environment });
    let reads = 0;
    peer.mcpRuntimeConfig = (_, entry) => {
      reads++;
      return entry;
    };
    assert.deepEqual(JSON.parse((peer as any).mcpConfig()), {});
    assert.equal(reads, 0);
  }
});

test("real startup notifications redact native values before BOTH retained stores, including prior configurations", (t) => {
  const { store, engine, config } = fixture(t);
  store.settings.mcpServers = { demo: { command: "node" } };
  let secret = "native-only-unique-secret";
  engine.mcpRuntimeSecrets = () => [secret];
  config();
  secret = "replacement-native-secret";
  const notify = (error: unknown) =>
    (engine as any).notification({
      method: "mcpServer/startupStatus/updated",
      params: { name: "demo", status: "failed", error },
    });
  notify("native-only-unique-secret replacement-native-secret");
  const retained = JSON.stringify([
    engine.mcpStartup.get("demo"),
    engine.mcpLogs.read("demo"),
  ]);
  assert.ok(!retained.includes("native-only-unique-secret"));
  assert.ok(!retained.includes("replacement-native-secret"));
  assert.match(retained, /redacted/);
  secret = 'multi-line-secret\nquoted-"credential';
  notify(JSON.stringify(secret));
  const escaped = JSON.stringify([
    engine.mcpStartup.get("demo"),
    engine.mcpLogs.read("demo"),
  ]);
  assert.ok(!escaped.includes("multi-line-secret"));
  assert.ok(!escaped.includes("credential"));
  engine.mcpRuntimeSecrets = () => {
    throw Error("locked-native-secret");
  };
  notify("locked-native-secret");
  assert.equal(
    engine.mcpStartup.get("demo")?.error,
    "MCP server startup failed.",
  );
  assert.ok(
    !JSON.stringify(engine.mcpLogs.read("demo")).includes(
      "locked-native-secret",
    ),
  );
});

test("maintenance blocks real sends and starts before any conversation or process, and applies to future peers", async (t) => {
  const { store, engine } = fixture(t);
  engine.mcpMaintenance = () => true;
  const provider = store.settings.providers[0];
  await assert.rejects(engine.ensure(provider), /extension maintenance/);
  await assert.rejects(
    engine.send({
      text: "test",
      mode: "chat",
      attachments: [],
      providerId: provider.id,
      model: provider.model,
    }),
    /extension maintenance/,
  );
  const peer = engine.createPeer({
    environment: { kind: "ssh", hostId: "remote" },
  });
  await assert.rejects(peer.ensure(provider), /extension maintenance/);
  assert.equal(store.conversations.length, 0);
  assert.equal(engine.rpc, undefined);
});
