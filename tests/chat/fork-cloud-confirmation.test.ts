import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudStore } from "../../runner/src/cloud-store";
import type { Conversation } from "../../shared/types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: test.TestContext, request: (op: string, body: any) => Promise<unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-confirm-"));
  const store = new CloudStore({ root, userId: 1, log() {}, transport: { request: (op, _user, body) => request(op, body) } });
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const turn = { id: "old", prompt: "hello", attachments: [], items: [], status: "completed" as const, createdAt: 1 };
  const source: Conversation = { id: "source", title: "Source", mode: "chat", providerId: "p", model: "m", threadId: "thread", createdAt: 1, updatedAt: 1, pinned: false, archived: false, turns: [turn], forks: [{ conversationId: "child", turnId: "old", createdAt: 2 }] };
  const child: Conversation = { ...structuredClone(source), id: "child", threadId: "fork", forks: undefined, forkedFrom: { conversationId: "source", turnId: "old", title: "Source" } };
  store.conversations.push(child, source);
  return { store, source, child };
}

test("fork confirmation waits for both child history and source linkage", async t => {
  const wait = deferred(), entered = deferred();
  const writes: string[] = [];
  const { store, source, child } = fixture(t, async (op, body) => {
    writes.push(op);
    if (op === "store.conversations.put" && body.doc.conversation.id === "source") {
      entered.resolve(); await wait.promise;
    }
    return {};
  });
  store.flush();
  let confirmed = false;
  const result = store.confirmChatFork(source, child, () => true).then(() => { confirmed = true; });
  await entered.promise;
  assert.equal(confirmed, false);
  wait.resolve();
  await result;
  assert.equal(confirmed, true);
  assert.equal(writes.filter(op => op === "store.conversations.put").length, 2);
  assert.equal(writes.filter(op => op === "store.turns.put").length, 2);
});

test("rejected child turn write cannot acknowledge the fork or trigger an immediate retry", async t => {
  let rejected = false, writes = 0;
  const { store, source, child } = fixture(t, async op => {
    if (op === "store.turns.put") { writes++; rejected = true; throw Error("offline"); }
    return {};
  });
  store.flush();
  await assert.rejects(store.confirmChatFork(source, child, () => true), /could not be confirmed/);
  assert.equal(rejected, true);
  assert.equal(writes, 1);
});

test("a changed child or retired account cannot consume an earlier acknowledgement", async t => {
  for (const change of ["child", "account"] as const) {
    const wait = deferred(), entered = deferred();
    let current = true;
    const { store, source, child } = fixture(t, async op => {
      if (op === "store.turns.put") { entered.resolve(); await wait.promise; }
      return {};
    });
    store.flush();
    const result = assert.rejects(store.confirmChatFork(source, child, () => current), /could not be confirmed/);
    await entered.promise;
    if (change === "child") child.turns[0].prompt = "changed";
    else current = false;
    wait.resolve();
    await result;
  }
});
