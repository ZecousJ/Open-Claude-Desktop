import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CloudStore, type StoreTransport } from "../runner/src/cloud-store";
import { openPolicy } from "../shared/client-policy";
import {
  memoryWebstore,
  useElectronShim,
} from "./runner/runner-core-support.test";

useElectronShim();
const { WebMcpConfig } = await import("../runner/src/web-app-support");
const original = { wiki: { url: "https://example.test/mcp" } };
const disabled = {
  wiki: { url: "https://example.test/mcp", disabled_tools: ["search"] },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-account-policy-"));
  const backend = memoryWebstore();
  let gate: ReturnType<typeof deferred> | undefined;
  let entered = deferred();
  let fail = false;
  let puts = 0;
  const transport: StoreTransport = {
    async request(op, user, body) {
      if (op === "store.settings.put") {
        puts++;
        const waiting = gate;
        gate = undefined;
        entered.resolve();
        if (waiting) await waiting.promise;
        const result = await backend.request(op, user, body);
        if (fail) throw Error("ACK lost after commit");
        return result;
      }
      return backend.request(op, user, body);
    },
  };
  const store = await CloudStore.open({ root, userId: 7, transport, log() {} });
  store.settings.mcpServers = structuredClone(original);
  await store.sync();
  puts = 0;
  let identity = {},
    events = 0,
    stops = 0;
  const ctx = {
    store,
    closed: false,
    officialSessionIdentity: () => identity,
    policy: () => openPolicy,
    settingsChanged: () => {
      events++;
    },
    engineRunning: () => true,
    busy: () => false,
    stopEngine: async () => {
      stops++;
    },
    connectorTokens: { keepOnly() {}, set() {} },
  } as unknown as ConstructorParameters<typeof WebMcpConfig>[0];
  const config = new WebMcpConfig(ctx);
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    backend,
    config,
    transport,
    get puts() {
      return puts;
    },
    get events() {
      return events;
    },
    get stops() {
      return stops;
    },
    block() {
      gate = deferred();
      entered = deferred();
      return { release: gate.resolve, entered: entered.promise };
    },
    loseAck() {
      fail = true;
    },
    retire() {
      identity = {};
    },
  };
}

test("account connector changes publish and restart only after the exact settings ACK", async (t) => {
  const f = await fixture(t),
    gate = f.block();
  const pending = f.config.commitToolPolicy(disabled, () => true);
  await gate.entered;
  assert.deepEqual(f.store.settings.mcpServers, original);
  assert.equal(f.events, 0);
  assert.equal(f.stops, 0);
  f.store.settings.name = "Concurrent account name";
  gate.release();
  await pending;
  assert.deepEqual(f.store.settings.mcpServers, disabled);
  assert.equal(f.store.settings.name, "Concurrent account name");
  assert.equal(f.events, 1);
  const saved = (await f.backend.request("store.settings.get", 7, {})) as {
    settings: { name: string; mcpServers: unknown };
  };
  assert.deepEqual(saved.settings.mcpServers, disabled);
  assert.notEqual(saved.settings.name, "Concurrent account name");
  await f.store.sync();
  const merged = (await f.backend.request("store.settings.get", 7, {})) as {
    settings: { name: string; mcpServers: unknown };
  };
  assert.equal(merged.settings.name, "Concurrent account name");
  assert.deepEqual(merged.settings.mcpServers, disabled);
});

test("lost settings ACK keeps the candidate unpublished and prevents whole-row replay", async (t) => {
  const f = await fixture(t);
  f.loseAck();
  await assert.rejects(
    f.config.commitToolPolicy(disabled, () => true),
    /outcome is unknown/,
  );
  assert.deepEqual(f.store.settings.mcpServers, original);
  assert.equal(f.events, 0);
  assert.equal(f.stops, 0);
  f.store.settings.name = "Later unrelated edit";
  await f.store.sync();
  await assert.rejects(
    f.config.commitToolPolicy(original, () => true),
    /unknown outcome/,
  );
  assert.throws(() => f.config.update(original), /unknown outcome/);
  assert.equal(f.puts, 1);
  const saved = (await f.backend.request("store.settings.get", 7, {})) as {
    settings: { mcpServers: unknown };
  };
  assert.deepEqual(saved.settings.mcpServers, disabled);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-account-reopen-"));
  const reopened = await CloudStore.open({
    root,
    userId: 7,
    transport: f.backend,
    log() {},
  });
  assert.deepEqual(reopened.settings.mcpServers, disabled);
  await reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("account retirement during settings ACK cannot publish into the replacement activation", async (t) => {
  const f = await fixture(t),
    gate = f.block();
  const pending = f.config.commitToolPolicy(disabled, () => true);
  await gate.entered;
  f.retire();
  gate.release();
  await assert.rejects(pending, /outcome is unknown/);
  assert.deepEqual(f.store.settings.mcpServers, original);
  assert.equal(f.events, 0);
  await f.store.sync();
  assert.equal(f.puts, 1);
});

test("a competing connector replacement is not overwritten after the old settings ACK", async (t) => {
  const f = await fixture(t),
    gate = f.block();
  const pending = f.config.commitToolPolicy(disabled, () => true);
  await gate.entered;
  const replacement = { wiki: { url: "https://replacement.test/mcp" } };
  f.store.settings.mcpServers = replacement;
  gate.release();
  await assert.rejects(pending, /outcome is unknown/);
  assert.equal(f.store.settings.mcpServers, replacement);
  assert.equal(f.events, 0);
  await f.store.sync();
  assert.equal(f.puts, 1);
});

test("tool policy commits cannot change connection identity or replay a queued stale document", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.config.commitToolPolicy(
      { wiki: { url: "https://other.test/mcp" } },
      () => true,
    ),
    /cannot replace/,
  );
  assert.equal(f.puts, 0);
  const gate = f.block();
  const first = f.config.commitToolPolicy(disabled, () => true);
  await gate.entered;
  const second = f.config.commitToolPolicy(original, () => true);
  const refused = assert.rejects(second, /configuration changed/);
  gate.release();
  await first;
  await refused;
  assert.equal(f.puts, 1);
  assert.deepEqual(f.store.settings.mcpServers, disabled);
});
