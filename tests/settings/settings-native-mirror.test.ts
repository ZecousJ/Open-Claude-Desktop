import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import {
  McpConfigFile,
  mcpConfigText,
  parseMcpConfig,
} from "../../electron/connectors/mcp-config-file";
import {
  prepareNativeExtensionMirror,
  recoverNativeExtensionMirror,
  commitNativeMcpServers,
} from "../../electron/connectors/native-extension-mirror";

const before = {
  demo: {
    command: "node",
    enabled: true,
    claudex_extension_settings: "old-version",
  },
};
const after = {
  demo: {
    command: "node",
    enabled: false,
    claudex_extension_settings: "new-version",
  },
};
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b34-native-mirror-"),
  );
  const store = new Store(root);
  store.settings.mcpServers = structuredClone(before);
  store.flush();
  const file = path.join(root, "mcp-config.json");
  fs.writeFileSync(file, mcpConfigText(before));
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const commitPrimary = () => {
    prepareNativeExtensionMirror(root, store.settings.mcpServers, after);
    store.settings.mcpServers = structuredClone(after);
    store.write("settings.json", store.settings);
  };
  const reopen = () => {
    const reopened = new Store(root);
    const applied: Record<string, unknown>[] = [];
    const mirror = new McpConfigFile(
      root,
      () => reopened.settings.mcpServers,
      (servers) => {
        applied.push(servers);
        reopened.settings.mcpServers = servers;
        reopened.write("settings.json", reopened.settings);
      },
      () => recoverNativeExtensionMirror(root, reopened.settings.mcpServers),
    );
    mirror.ensure();
    mirror.reload();
    mirror.close();
    return { reopened, applied, error: mirror.error };
  };
  return { root, store, file, commitPrimary, reopen };
}

test("a real restart cannot re-enable an old extension after primary commit and secondary mirror failure", (t) => {
  const env = fixture(t);
  env.commitPrimary(); // Crash/failure before the secondary mirror changes.
  assert.deepEqual(parseMcpConfig(fs.readFileSync(env.file, "utf8")), before);
  const { reopened, applied, error } = env.reopen();
  assert.equal(error, undefined);
  assert.deepEqual(reopened.settings.mcpServers, after);
  assert.deepEqual(applied, []);
  assert.deepEqual(parseMcpConfig(fs.readFileSync(env.file, "utf8")), after);
  const second = env.reopen();
  assert.deepEqual(second.reopened.settings.mcpServers, after);
});

test("a genuinely different external edit is preserved instead of being overwritten by pending mirror recovery", (t) => {
  const env = fixture(t);
  env.commitPrimary();
  const edited = { demo: { command: "python", enabled: false } };
  fs.writeFileSync(env.file, mcpConfigText(edited));
  const { reopened, applied } = env.reopen();
  assert.deepEqual(reopened.settings.mcpServers, edited);
  assert.deepEqual(applied, [edited]);
});

test("an interrupted or failed primary publication never activates an uncommitted mirror target", (t) => {
  const env = fixture(t);
  prepareNativeExtensionMirror(env.root, before, after);
  const result = env.reopen();
  assert.deepEqual(result.reopened.settings.mcpServers, before);
  assert.deepEqual(result.applied, []);
});

test("a later failed save first recovers the prior committed mirror and cannot erase its receipt", (t) => {
  const env = fixture(t);
  env.commitPrimary();
  const uncommitted = {
    demo: {
      command: "node",
      enabled: true,
      claudex_extension_settings: "never-committed",
    },
  };
  prepareNativeExtensionMirror(
    env.root,
    env.store.settings.mcpServers,
    uncommitted,
  );
  const result = env.reopen();
  assert.deepEqual(result.reopened.settings.mcpServers, after);
  assert.deepEqual(parseMcpConfig(fs.readFileSync(env.file, "utf8")), after);
});

test("an unreadable or invalid mirror recovery refuses import without changing the primary", (t) => {
  const env = fixture(t);
  env.commitPrimary();
  fs.writeFileSync(env.file, "invalid external configuration");
  const result = env.reopen();
  assert.ok(result.error);
  assert.deepEqual(result.reopened.settings.mcpServers, after);
  assert.deepEqual(result.applied, []);
});

test("MCP settings commit neither flushes unrelated history nor reports a later history failure as a failed edit", (t) => {
  const env = fixture(t);
  const flush = env.store.flush.bind(env.store);
  env.store.flush = () => {
    throw Error("Unrelated history write failed");
  };
  try {
    commitNativeMcpServers(env.store, after);
  } finally {
    env.store.flush = flush;
  }
  assert.deepEqual(new Store(env.root).settings.mcpServers, after);
  assert.deepEqual(env.reopen().reopened.settings.mcpServers, after);
});
