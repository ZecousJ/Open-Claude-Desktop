import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

function setup(call: (method: string, params: any) => Promise<any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-fork-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "c",
    title: "Source",
    mode: "code",
    providerId: "default",
    model: "m",
    threadId: "source",
    pinned: true,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    unread: true,
    turns: ["a", "b", "c"].map((id, i) => ({
      id,
      prompt: id,
      attachments: [],
      items: [],
      status: "completed",
      createdAt: i + 1,
    })),
  };
  store.conversations.push(c);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.ensure = async () => {};
  engine.rpc = { call } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return {
    store,
    c,
    engine,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Fork from here continues after the chosen turn on a native fork and leaves the source as it is", async () => {
  const calls: [string, any][] = [];
  const env = setup(async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/fork") return { thread: { id: "forked" } };
    return {};
  });
  try {
    const forked = await env.engine.forkConversation("c", "b");
    const fork = calls.find(([m]) => m === "thread/fork")![1];
    assert.equal(fork.threadId, "source");
    assert.equal(fork.lastTurnId, "b");
    assert.equal(forked.threadId, "forked");
    assert.deepEqual(
      forked.turns.map((t) => t.id),
      ["a", "b"],
    );
    assert.deepEqual(forked.forkedFrom, {
      conversationId: "c",
      turnId: "b",
      title: "Source",
    });
    // A fresh, unpinned, read conversation of the same kind.
    assert.notEqual(forked.id, "c");
    assert.equal(forked.mode, "code");
    assert.equal(forked.pinned, false);
    assert.equal(forked.unread, undefined);
    assert.equal(env.store.conversations[0].id, forked.id);
    // The source keeps its turns and thread, and records the fork.
    assert.deepEqual(
      env.c.turns.map((t) => t.id),
      ["a", "b", "c"],
    );
    assert.equal(env.c.threadId, "source");
    assert.deepEqual(
      env.c.forks?.map((f) => [f.conversationId, f.turnId]),
      [[forked.id, "b"]],
    );
  } finally {
    env.close();
  }
});

test("Fork session takes the last finished turn and skips a running one", async () => {
  const env = setup(async (method, params) => {
    if (method === "thread/fork") {
      assert.equal(params.lastTurnId, "b");
      return { thread: { id: "forked" } };
    }
    return {};
  });
  try {
    env.c.turns[2].status = "inProgress";
    const forked = await env.engine.forkConversation("c");
    assert.deepEqual(
      forked.turns.map((t) => t.id),
      ["a", "b"],
    );
  } finally {
    env.close();
  }
});

test("forking refuses incognito chats, running replies and a failed native fork leaves no trace", async () => {
  const env = setup(async (method) => {
    if (method === "thread/fork") throw new Error("fork unavailable");
    return {};
  });
  try {
    env.c.turns[2].status = "inProgress";
    await assert.rejects(
      env.engine.forkConversation("c", "c"),
      /Wait for this reply to finish/,
    );
    env.c.turns[2].status = "completed";
    const before = structuredClone(env.c);
    await assert.rejects(env.engine.forkConversation("c"), /fork unavailable/);
    assert.equal(env.store.conversations.length, 1);
    assert.deepEqual(env.c.forks, before.forks);
    env.c.incognito = true;
    await assert.rejects(env.engine.forkConversation("c"), /incognito/);
  } finally {
    env.close();
  }
});
