import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import type { Conversation } from "../shared/types";

const patch = () => ({
  connectorOverrides: { drive: false },
  connectorToolOverrides: { drive: { search: true } },
});
const row = (): Conversation =>
  ({
    id: "session",
    title: "Unchanged",
    mode: "chat",
    providerId: "provider",
    model: "model",
    pinned: true,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    research: true,
    webSearch: true,
  }) as Conversation;
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const conversation = row();
  store.conversations.push(conversation);
  return { store, conversation, root };
}
test("local connector commit survives a cold reload and preserves unrelated flags", async (t) => {
  const { store, conversation, root } = fixture(t);
  const candidate = patch();
  await store.persistSessionConnectorPreference(
    conversation,
    candidate,
    () => true,
  );
  candidate.connectorToolOverrides.drive.search = false;
  const loaded = new Store(root).conversation(conversation.id);
  assert.deepEqual(loaded.connectorOverrides, { drive: false });
  assert.deepEqual(loaded.connectorToolOverrides, { drive: { search: true } });
  assert.equal(conversation.connectorToolOverrides?.drive.search, true);
  assert.equal(loaded.research, true);
  assert.equal(loaded.webSearch, true);
  assert.equal(loaded.pinned, true);
  assert.equal(loaded.title, "Unchanged");
});
test("failed atomic save never publishes the candidate or damages the prior file", async (t) => {
  const { store, conversation, root } = fixture(t);
  store.flush();
  const previous = fs.readFileSync(
    path.join(root, "conversations.json"),
    "utf8",
  );
  store.write = () => {
    throw Error("disk full");
  };
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => true),
    /disk full/,
  );
  assert.equal(conversation.connectorOverrides, undefined);
  assert.equal(
    fs.readFileSync(path.join(root, "conversations.json"), "utf8"),
    previous,
  );
});
test("local incognito preference is memory only", async (t) => {
  const { store, conversation, root } = fixture(t);
  conversation.incognito = true;
  store.write = () => {
    throw Error("must not write");
  };
  await store.persistSessionConnectorPreference(
    conversation,
    patch(),
    () => true,
  );
  assert.deepEqual(conversation.connectorOverrides, patch().connectorOverrides);
  assert.equal(fs.existsSync(path.join(root, "conversations.json")), false);
});
test("local account, duplicate identity and stale row guards reject before write", async (t) => {
  const { store, conversation } = fixture(t);
  store.write = () => {
    throw Error("unexpected disk write");
  };
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => false),
    /changed/,
  );
  await assert.rejects(
    store.persistSessionConnectorPreference(
      { ...conversation },
      patch(),
      () => true,
    ),
    /changed/,
  );
  store.conversations.push({ ...conversation });
  await assert.rejects(
    store.persistSessionConnectorPreference(conversation, patch(), () => true),
    /changed/,
  );
});
test("local post-write account change does not publish success", async (t) => {
  const { store, conversation } = fixture(t);
  let current = true;
  const write = store.write.bind(store);
  store.write = (name, value) => {
    write(name, value);
    current = false;
  };
  await assert.rejects(
    store.persistSessionConnectorPreference(
      conversation,
      patch(),
      () => current,
    ),
    /unknown/,
  );
  assert.equal(conversation.connectorOverrides, undefined);
});
