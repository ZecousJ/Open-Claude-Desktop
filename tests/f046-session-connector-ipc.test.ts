import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { saveSessionConnectorPreference } from "../electron/ipc/session-connector-preference";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import {
  sessionConnectorPreferenceSnapshot,
  type SessionConnectorPreference,
} from "../shared/session-connector-preference";
import type { Conversation } from "../shared/types";
import type { Context } from "../electron/ipc/conversations";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH, hiwonderKnowledgeEnabled } from "../shared/knowledge-api";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const c = {
    id: "chat-a",
    mode: "chat",
    createdAt: 1,
    updatedAt: 1,
    title: "Title",
    turns: [],
    connectorOverrides: {},
    connectorToolOverrides: {},
    research: true,
    webSearch: true,
  } as unknown as Conversation;
  store.conversations = [c];
  store.settings.mcpServers = { wiki: { url: "https://fixture.invalid/mcp" } };
  let generation: unknown = {},
    activeStore = store,
    owner = "owner-a",
    retiring = false;
  const pushes: any[] = [];
  const context = {
    get store() {
      return activeStore;
    },
    accountGeneration: () => generation,
    get activeAccount() {
      return { id: owner };
    },
    get accountRetiring() {
      return retiring;
    },
    push: (event: unknown) => pushes.push(structuredClone(event)),
  } as unknown as Context;
  const value = () => ({
    connectorOverrides: { wiki: false },
    connectorToolOverrides: { wiki: { search: false } },
  });
  const envelope = (patch: SessionConnectorPreference = value()) => ({
    connectorToolOverrides: {
      version: 1,
      expected: sessionConnectorPreferenceSnapshot(c),
      identity: {
        id: c.id,
        createdAt: c.createdAt ?? null,
        mode: c.mode ?? null,
      },
      value: patch,
    },
  });
  const run = (raw: unknown) =>
    saveSessionConnectorPreference(context, c.id, raw);
  return {
    store,
    c,
    root,
    context,
    pushes,
    value,
    envelope,
    run,
    replace() {
      generation = {};
      owner = "owner-b";
      activeStore = new Store(root);
    },
    retire() {
      retiring = true;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("the managed knowledge choice requires an available offer, then reopens and can be disabled offline", async (t) => {
  const e = fixture(t);
  let available = false;
  let reads = 0;
  e.context.knowledgeCatalog = async () => {
    reads++;
    return [{ id: HUANER_TECH, name: "Hiwonder", description: "", available }];
  };
  const choice = (enabled: boolean, tools: Record<string, boolean> = {}) =>
    e.envelope({
      connectorOverrides: { [HIWONDER_KNOWLEDGE_SERVER]: enabled },
      connectorToolOverrides: { [HIWONDER_KNOWLEDGE_SERVER]: tools },
    });
  await assert.rejects(e.run(choice(true)), /knowledge base is unavailable/);
  assert.equal(hiwonderKnowledgeEnabled(e.c), false);
  available = true;
  await assert.rejects(e.run(choice(true, { unlisted: true })), /does not exist/);
  await e.run(choice(true, { rag_read: false }));
  const reopened = new Store(e.root).conversation(e.c.id);
  assert.equal(hiwonderKnowledgeEnabled(reopened), true);
  assert.equal(reopened.connectorToolOverrides?.[HIWONDER_KNOWLEDGE_SERVER]?.rag_read, false);
  available = false;
  await e.run(choice(false, { rag_search: false, rag_read: false }));
  assert.equal(reads, 3);
  assert.equal(hiwonderKnowledgeEnabled(new Store(e.root).conversation(e.c.id)), false);
});

test("a delayed knowledge availability read cannot enable a connector after an account switch", async (t) => {
  const e = fixture(t);
  const started = deferred();
  const finish = deferred();
  e.context.knowledgeCatalog = async () => {
    started.resolve();
    await finish.promise;
    return [{ id: HUANER_TECH, name: "Hiwonder", description: "", available: true }];
  };
  const pending = e.run(e.envelope({
    connectorOverrides: { [HIWONDER_KNOWLEDGE_SERVER]: true },
    connectorToolOverrides: {},
  }));
  await started.promise;
  e.replace();
  finish.resolve();
  await assert.rejects(pending, /account, conversation or connector configuration changed/);
  assert.equal(hiwonderKnowledgeEnabled(e.c), false);
  assert.equal(e.pushes.length, 0);
});

test("F046 handler routes connector-only updates through durable guarded persistence", async (t) => {
  const e = fixture(t),
    handlers = new Map<string, Function>();
  registerConversationManageHandlers({
    context: e.context,
    engineOf: () => undefined,
    handle: (name, fn) => handlers.set(name, fn),
  });
  const saved = await handlers.get("updateConversation")!(e.c.id, e.envelope());
  assert.equal(saved.connectorOverrides.wiki, false);
  assert.equal(
    new Store(e.root).conversation(e.c.id).connectorToolOverrides?.wiki.search,
    false,
  );
  assert.equal(saved.research, true);
  assert.equal(saved.webSearch, true);
  assert.equal(e.pushes.length, 1);
});
test("F046 legacy connector-only update also commits instead of falling through to flush", async (t) => {
  const e = fixture(t);
  await e.run({ connectorOverrides: { wiki: false } });
  assert.equal(
    new Store(e.root).conversation(e.c.id).connectorOverrides?.wiki,
    false,
  );
});
test("F046 canonical snapshots ignore insertion order but distinguish explicit choices", () => {
  const a = {
    connectorOverrides: { a: false, b: true },
    connectorToolOverrides: { a: { one: false, two: true } },
  };
  const b = {
    connectorOverrides: { b: true, a: false },
    connectorToolOverrides: { a: { two: true, one: false } },
  };
  assert.equal(
    sessionConnectorPreferenceSnapshot(a),
    sessionConnectorPreferenceSnapshot(b),
  );
  assert.notEqual(
    sessionConnectorPreferenceSnapshot(a),
    sessionConnectorPreferenceSnapshot({}),
  );
});
test("F046 stale snapshot and recreated identity reject before persistence", async (t) => {
  const e = fixture(t),
    raw = e.envelope();
  e.c.connectorOverrides = { wiki: true };
  await assert.rejects(e.run(raw), /preferences changed/);
  e.c.connectorOverrides = {};
  e.c.createdAt = 2;
  await assert.rejects(e.run(raw), /identity changed/);
  assert.equal(e.pushes.length, 0);
  assert.equal(fs.existsSync(path.join(e.root, "conversations.json")), false);
});
test("F046 missing account generation fails closed", async (t) => {
  const e = fixture(t);
  delete e.context.accountGeneration;
  await assert.rejects(e.run(e.envelope()), /unavailable/);
  assert.equal(e.pushes.length, 0);
});
test("F046 running, bound incognito and foreign-authored sessions reject", async (t) => {
  for (const condition of ["running", "incognito", "foreign"] as const) {
    const e = fixture(t);
    if (condition === "running") e.c.turns = [{ status: "inProgress" } as any];
    if (condition === "incognito") {
      e.c.incognito = true;
      e.c.threadId = "bound";
    }
    if (condition === "foreign")
      e.c.sessionAuthors = {
        ownerAccountUuid: "other",
        viewerAccountUuid: "owner-a",
      };
    await assert.rejects(e.run(e.envelope()), /changed/);
    assert.equal(e.pushes.length, 0);
  }
});
test("F046 unchanged orphan maps survive but new, edited or removed orphan choices reject", async (t) => {
  const e = fixture(t);
  e.c.connectorOverrides = { removed: false };
  e.c.connectorToolOverrides = { removed: { old: false } };
  const retained = {
    connectorOverrides: { removed: false, wiki: false },
    connectorToolOverrides: {
      removed: { old: false },
      wiki: { search: false },
    },
  };
  await e.run(e.envelope(retained));
  for (const value of [
    e.value(),
    { ...retained, connectorOverrides: { removed: true, wiki: false } },
    {
      ...retained,
      connectorToolOverrides: {
        removed: { old: true },
        wiki: { search: false },
      },
    },
  ])
    await assert.rejects(e.run(e.envelope(value as any)), /no longer exists/);
  assert.equal(e.c.connectorOverrides.removed, false);
});
test("F046 unknown server cannot be introduced through connector-only or guarded patch", async (t) => {
  const e = fixture(t);
  await assert.rejects(
    e.run({ connectorOverrides: { missing: true } }),
    /no longer exists/,
  );
  await assert.rejects(
    e.run(
      e.envelope({
        connectorOverrides: {},
        connectorToolOverrides: { missing: { search: true } },
      }),
    ),
    /no longer exists/,
  );
  assert.equal(e.pushes.length, 0);
});
test("F046 mixed metadata, malformed envelope and injected definitions reject without effects", async (t) => {
  const e = fixture(t);
  for (const raw of [
    { ...e.envelope(), title: "Injected" },
    { connectorToolOverrides: { version: 2 } },
    { connectorOverrides: { wiki: "false" } },
    { connectorOverrides: {}, url: "https://bad.invalid" },
  ])
    await assert.rejects(e.run(raw));
  assert.equal(e.c.title, "Title");
  assert.equal(e.pushes.length, 0);
});
test("F046 queued stale full snapshot cannot overwrite an earlier acknowledged save", async (t) => {
  const e = fixture(t),
    gate = deferred();
  const persist = e.store.persistSessionConnectorPreference.bind(e.store);
  let calls = 0;
  e.store.persistSessionConnectorPreference = async (...args) => {
    calls++;
    await gate.promise;
    return persist(...args);
  };
  const first = e.run(e.envelope()),
    second = e.run(
      e.envelope({
        connectorOverrides: { wiki: true },
        connectorToolOverrides: {},
      }),
    );
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  gate.resolve();
  await first;
  await assert.rejects(second, /preferences changed/);
  assert.equal(calls, 1);
  assert.equal(e.c.connectorOverrides?.wiki, false);
});
test("F046 failed known save does not poison the next queued request", async (t) => {
  const e = fixture(t),
    persist = e.store.persistSessionConnectorPreference.bind(e.store);
  let calls = 0;
  e.store.persistSessionConnectorPreference = async (...args) => {
    if (++calls === 1) throw Error("disk full");
    return persist(...args);
  };
  const first = e.run(e.envelope()),
    second = e.run(e.envelope());
  await assert.rejects(first, /disk full/);
  await second;
  assert.equal(e.c.connectorOverrides?.wiki, false);
  assert.equal(e.pushes.length, 1);
});
test("F046 account/configuration changes before queued execution reject without effects", async (t) => {
  for (const transition of ["replace", "retire", "config"] as const) {
    const e = fixture(t),
      pending = e.run(e.envelope());
    if (transition === "config") e.store.settings.mcpServers = {};
    else e[transition]();
    await assert.rejects(pending, /changed/);
    assert.equal(e.pushes.length, 0);
  }
});
test("F046 duplicate row identities reject and save request input is copied", async (t) => {
  const e = fixture(t);
  e.store.conversations.push({ ...e.c });
  await assert.rejects(e.run(e.envelope()), /changed/);
  e.store.conversations.pop();
  const raw = e.envelope(),
    pending = e.run(raw);
  raw.connectorToolOverrides.value.connectorOverrides.wiki = true;
  await pending;
  assert.equal(e.c.connectorOverrides?.wiki, false);
});
test("F046 a fake persistence success is not published to UI", async (t) => {
  const e = fixture(t);
  e.store.persistSessionConnectorPreference = async () => {};
  await assert.rejects(e.run(e.envelope()), /could not be confirmed/);
  assert.equal(e.pushes.length, 0);
});
