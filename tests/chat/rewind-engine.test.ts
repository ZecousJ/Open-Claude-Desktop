import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

function setup(call: (method: string, params: any) => Promise<any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-rewind-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "c",
    title: "Source",
    mode: "code",
    providerId: "default",
    model: "m",
    threadId: "source",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
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
const ids = (c: Conversation) => c.turns.map((t) => t.id);

test("Rewind to here removes the message and what follows, continuing on a fork before it", async () => {
  const forks: any[] = [];
  const env = setup(async (method, params) => {
    if (method === "thread/fork") {
      forks.push(params);
      return { thread: { id: "rewound" } };
    }
    return {};
  });
  try {
    await env.engine.rewindConversation("c", "b");
    assert.equal(forks[0].lastTurnId, "a");
    assert.deepEqual(ids(env.c), ["a"]);
    assert.equal(env.c.threadId, "rewound");
    assert.equal(env.c.rewind?.variant, "pending");
    assert.deepEqual(
      env.c.rewind?.turns.map((t) => t.id),
      ["b", "c"],
    );
    // Undo brings them back on their own thread; Redo sets them aside again.
    await env.engine.swapRewind("c");
    assert.deepEqual(ids(env.c), ["a", "b", "c"]);
    assert.equal(env.c.threadId, "source");
    assert.equal(env.c.rewind?.variant, "forward");
    await env.engine.swapRewind("c");
    assert.deepEqual(ids(env.c), ["a"]);
    assert.equal(env.c.threadId, "rewound");
    assert.equal(env.c.rewind?.variant, "pending");
  } finally {
    env.close();
  }
});

test("/rewind takes back the last message; rewinding the first starts the thread afresh", async () => {
  const env = setup(async (method) => {
    if (method === "thread/fork") return { thread: { id: "f" } };
    return {};
  });
  try {
    await env.engine.rewindConversation("c");
    assert.deepEqual(ids(env.c), ["a", "b"]);
    await env.engine.rewindConversation("c", "a");
    assert.deepEqual(ids(env.c), []);
    assert.equal(env.c.threadId, undefined);
  } finally {
    env.close();
  }
});

test("rewind is refused while a reply runs, and Undo once a message was sent after it", async () => {
  const env = setup(async (method) => {
    if (method === "thread/fork") return { thread: { id: "f" } };
    return {};
  });
  try {
    env.c.turns[2].status = "inProgress";
    await assert.rejects(
      env.engine.rewindConversation("c", "b"),
      /while Claudex is working/,
    );
    env.c.turns[2].status = "completed";
    await env.engine.rewindConversation("c", "c");
    delete env.c.rewind; // what sending a message does
    await assert.rejects(
      env.engine.swapRewind("c"),
      /message was sent after it/,
    );
  } finally {
    env.close();
  }
});
