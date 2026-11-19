import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudStore, type StoreTransport } from "../runner/src/cloud-store";
import {
  splitConversation,
  type ConversationDoc,
  type TurnDoc,
} from "../shared/web-docs";
import type { Conversation } from "../shared/types";
const patch = () => ({
  connectorOverrides: { drive: false },
  connectorToolOverrides: { drive: { search: true } },
});
const row = (): Conversation =>
  ({
    id: "session",
    title: "Original",
    mode: "chat",
    providerId: "provider",
    model: "model",
    pinned: true,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    research: true,
    webSearch: true,
    turns: [
      {
        id: "turn",
        prompt: "hello",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  }) as Conversation;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Transport implements StoreTransport {
  doc: ConversationDoc;
  turns: TurnDoc[];
  calls: { op: string; body: any; userId: number }[] = [];
  hold?: {
    started: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  };
  fail = false;
  constructor() {
    const split = splitConversation(row());
    this.doc = split.doc;
    this.turns = split.turns;
  }
  async request(op: string, userId: number, body?: any): Promise<any> {
    this.calls.push({ op, body: structuredClone(body), userId });
    if (op === "store.settings.get") return { settings: null };
    if (op === "store.projects.list") return { projects: [] };
    if (op === "store.conversations.list")
      return { items: [{ doc: structuredClone(this.doc), position: 0 }] };
    if (op === "store.turns.list")
      return { turns: structuredClone(this.turns) };
    if (op === "store.conversations.put") {
      const hold = this.hold;
      this.hold = undefined;
      hold?.started.resolve();
      if (hold) await hold.release.promise;
      this.doc = structuredClone(body.doc);
      if (this.fail) throw Error("ACK lost after commit");
    }
    return {};
  }
  gate() {
    const gate = { started: deferred(), release: deferred() };
    this.hold = gate;
    return gate;
  }
  puts() {
    return this.calls.filter((c) => c.op === "store.conversations.put");
  }
}
async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-cloud-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transport = new Transport();
  const store = await CloudStore.open({
    root,
    userId: 7,
    transport,
    log: () => {},
  });
  return { root, transport, store, conversation: store.conversations[0] };
}
test("cloud stages until ACK, preserves turn hashes and reloads the exact committed maps", async (t) => {
  const { store, conversation, transport, root } = await fixture(t);
  const gate = transport.gate();
  const candidate = patch();
  const saving = store.persistSessionConnectorPreference(
    conversation,
    candidate,
    () => true,
  );
  await gate.started.promise;
  assert.equal(conversation.connectorOverrides, undefined);
  candidate.connectorToolOverrides.drive.search = false;
  conversation.title = "Concurrent title";
  gate.release.resolve();
  await saving;
  assert.equal(conversation.connectorToolOverrides?.drive.search, true);
  assert.equal(conversation.title, "Concurrent title");
  assert.equal(transport.doc.conversation.title, "Original");
  await store.sync();
  assert.equal(transport.doc.conversation.title, "Concurrent title");
  assert.equal(transport.doc.conversation.research, true);
  assert.equal(transport.doc.conversation.webSearch, true);
  assert.equal(transport.doc.conversation.pinned, true);
  assert.equal(
    transport.calls.filter((c) => c.op === "store.turns.put").length,
    0,
  );
  const reopened = await CloudStore.open({ root, userId: 7, transport });
  assert.deepEqual(
    reopened.conversations[0].connectorToolOverrides,
    patch().connectorToolOverrides,
  );
  assert.equal(fs.existsSync(path.join(root, "conversations.json")), false);
});
test("lost cloud ACK quarantines row against retry, Research, metadata and deletion", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  transport.fail = true;
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => true),
    /unknown/,
  );
  assert.equal(conversation.connectorOverrides, undefined);
  assert.deepEqual(
    transport.doc.conversation.connectorOverrides,
    patch().connectorOverrides,
  );
  assert.throws(() => store.conversation(conversation.id), /could not be confirmed/);
  await assert.rejects(
    store.persistResearchPreference(conversation, false, false, () => true),
    /could not be confirmed/,
  );
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => true),
    /could not be confirmed/,
  );
  await assert.rejects(
    store.persistChatMetadata(conversation, { title: "bad" }, () => true),
    /could not be confirmed/,
  );
  await store.sync();
  store.conversations = [];
  await store.sync();
  assert.equal(transport.puts().length, 1);
  assert.equal(
    transport.calls.filter((c) => c.op === "store.conversations.delete").length,
    0,
  );
});
test("pending background writes drain before staging connector metadata", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  conversation.title = "Background";
  const gate = transport.gate();
  const background = store.sync();
  await gate.started.promise;
  const saving = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  await Promise.resolve();
  assert.equal(transport.puts().length, 1);
  gate.release.resolve();
  await Promise.all([background, saving]);
  assert.equal(transport.puts().length, 2);
  assert.equal(transport.doc.conversation.title, "Background");
  assert.deepEqual(
    transport.doc.conversation.connectorOverrides,
    patch().connectorOverrides,
  );
});
test("Research and connector saves serialize and preserve each other's fields", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  const gate = transport.gate();
  const research = store.persistResearchPreference(
    conversation,
    false,
    false,
    () => true,
  );
  await gate.started.promise;
  const saving = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  gate.release.resolve();
  await Promise.all([research, saving]);
  assert.equal(transport.doc.conversation.research, undefined);
  assert.equal(transport.doc.conversation.webSearch, false);
  assert.deepEqual(
    transport.doc.conversation.connectorOverrides,
    patch().connectorOverrides,
  );
});
test("queued stale connector candidate is rejected, never replayed over confirmed preference", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  const gate = transport.gate();
  const first = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  await gate.started.promise;
  const stale = store.persistSessionConnectorPreference(
    conversation,
    { connectorOverrides: {}, connectorToolOverrides: {} },
    () => true,
  );
  const rejected = assert.rejects(stale, /changed/);
  gate.release.resolve();
  await first;
  await rejected;
  assert.equal(transport.puts().length, 1);
});
for (const change of ["account", "identity", "maps"] as const) {
  test(
    "cloud post-ACK " + change + " change rejects and quarantines the row",
    async (t) => {
      const { store, conversation, transport } = await fixture(t);
      let current = true;
      const gate = transport.gate();
      const saving = store.persistSessionConnectorPreference(
        conversation,
        patch(),
        () => current,
      );
      const rejected = assert.rejects(saving, /unknown/);
      await gate.started.promise;
      if (change === "account") current = false;
      if (change === "identity") store.conversations = [{ ...conversation }];
      if (change === "maps") conversation.connectorOverrides = { drive: true };
      gate.release.resolve();
      await rejected;
      await store.sync();
      assert.equal(transport.puts().length, 1);
    },
  );
}
test("cloud rejects stale row, duplicate identity and stale account without sending", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  await assert.rejects(
    store.persistSessionConnectorPreference(
      { ...conversation },
      patch(),
      () => true,
    ),
    /changed/,
  );
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => false),
    /changed/,
  );
  store.conversations.push({ ...conversation });
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => true),
    /changed/,
  );
  assert.equal(transport.puts().length, 0);
});
test("cloud incognito commit is memory only", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  conversation.incognito = true;
  await store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  assert.deepEqual(conversation.connectorOverrides, patch().connectorOverrides);
  assert.equal(transport.puts().length, 0);
});
test("account change while waiting for background ACK prevents connector transmission", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  let current = true;
  conversation.title = "Dirty";
  const gate = transport.gate();
  const background = store.sync();
  await gate.started.promise;
  const saving = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => current,
  );
  const rejected = assert.rejects(saving, /changed/);
  current = false;
  gate.release.resolve();
  await background;
  await rejected;
  assert.equal(transport.puts().length, 1);
  assert.equal(conversation.connectorOverrides, undefined);
});
test("failed preceding history save prevents an unconfirmed connector commit", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  transport.fail = true;
  conversation.title = "Dirty";
  await store.sync();
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => true),
    /earlier history save failed/,
  );
  assert.equal(transport.puts().length, 1);
  assert.equal(conversation.connectorOverrides, undefined);
  transport.fail = false;
  await store.close();
});
test("Research and background sync wait behind a pending connector ACK", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  const gate = transport.gate();
  const saving = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  await gate.started.promise;
  const research = store.persistResearchPreference(
    conversation,
    false,
    false,
    () => true,
  );
  const background = store.sync();
  assert.throws(() => store.conversation(conversation.id), /pending/);
  gate.release.resolve();
  await Promise.all([saving, research, background]);
  assert.deepEqual(
    transport.doc.conversation.connectorOverrides,
    patch().connectorOverrides,
  );
  assert.equal(transport.doc.conversation.webSearch, false);
  assert.equal(transport.doc.conversation.research, undefined);
});
test("in-place conversation ID mutation cannot acknowledge a different row", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  const gate = transport.gate();
  const saving = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  const rejected = assert.rejects(saving, /unknown/);
  await gate.started.promise;
  conversation.id = "different";
  gate.release.resolve();
  await rejected;
  assert.equal(conversation.connectorOverrides, undefined);
  assert.throws(() => store.conversation("session"), /could not be confirmed/);
});
test("close during connector write cannot publish late success or replay the row", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  const gate = transport.gate();
  const saving = store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  const rejected = assert.rejects(saving, /unknown/);
  await gate.started.promise;
  const closing = store.close();
  gate.release.resolve();
  await rejected;
  await closing;
  assert.equal(conversation.connectorOverrides, undefined);
  assert.equal(transport.puts().length, 1);
});
test("reentrant background flush waits for the connector reservation", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  const request = transport.request.bind(transport);
  let sync: Promise<void> | undefined;
  transport.request = async (op, userId, body) => {
    if (op === "store.conversations.put" && !sync) {
      sync = store.sync();
      assert.equal(conversation.connectorOverrides, undefined);
    }
    return request(op, userId, body);
  };
  await store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  await sync;
  assert.equal(transport.puts().length, 1);
  assert.deepEqual(conversation.connectorOverrides, patch().connectorOverrides);
});

test("guarded IPC confirms policy-only changes after cloud ACK", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  store.settings.mcpServers = {
    drive: { url: "https://fixture.invalid/mcp", disabled_tools: ["search"] },
  };
  const { saveSessionConnectorPreference } =
    await import("../electron/ipc/session-connector-preference");
  const { sessionConnectorPreferenceSnapshot } =
    await import("../shared/session-connector-preference");
  const events: unknown[] = [];
  const context = {
    store,
    accountGeneration: () => 1,
    activeAccount: { id: "owner" },
    push: (event: unknown) => events.push(event),
  };
  const gate = transport.gate();
  const saving = saveSessionConnectorPreference(
    context as never,
    conversation.id,
    {
      connectorToolOverrides: {
        version: 1,
        expected: sessionConnectorPreferenceSnapshot(conversation),
        identity: {
          id: conversation.id,
          createdAt: conversation.createdAt,
          mode: conversation.mode,
        },
        value: patch(),
      },
    },
  );
  await gate.started.promise;
  assert.equal(events.length, 0);
  assert.equal(conversation.connectorOverrides, undefined);
  store.settings.mcpServers = {
    drive: {
      url: "https://fixture.invalid/mcp",
      tools: { search: { approval_mode: "prompt" } },
    },
  };
  gate.release.resolve();
  await saving;
  assert.deepEqual(conversation.connectorOverrides, patch().connectorOverrides);
  assert.equal(events.length, 1);
});

test("guarded IPC refuses same-name transport replacement during cloud ACK", async (t) => {
  const { store, conversation, transport } = await fixture(t);
  store.settings.mcpServers = {
    drive: {
      url: "https://fixture.invalid/mcp",
      headers: { Authorization: "old" },
    },
  };
  const { saveSessionConnectorPreference } =
    await import("../electron/ipc/session-connector-preference");
  const { sessionConnectorPreferenceSnapshot } =
    await import("../shared/session-connector-preference");
  const events: unknown[] = [];
  const context = {
    store,
    accountGeneration: () => 1,
    activeAccount: { id: "owner" },
    push: (event: unknown) => events.push(event),
  };
  const gate = transport.gate();
  const saving = saveSessionConnectorPreference(
    context as never,
    conversation.id,
    {
      connectorToolOverrides: {
        version: 1,
        expected: sessionConnectorPreferenceSnapshot(conversation),
        identity: {
          id: conversation.id,
          createdAt: conversation.createdAt,
          mode: conversation.mode,
        },
        value: patch(),
      },
    },
  );
  await gate.started.promise;
  store.settings.mcpServers = {
    drive: {
      url: "https://fixture.invalid/mcp",
      headers: { Authorization: "new" },
    },
  };
  gate.release.resolve();
  await assert.rejects(saving);
  assert.equal(events.length, 0);
});
