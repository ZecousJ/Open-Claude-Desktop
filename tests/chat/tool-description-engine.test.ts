import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { projectAgentItems } from "../../electron/conversations/agent-transcript-item";
import type { Conversation } from "../../shared/types";

function conversation(id: string, threadId: string): Conversation {
  return {
    id,
    title: id,
    mode: "code",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId,
    turns: [
      {
        id: "turn",
        prompt: "p",
        attachments: [],
        createdAt: 1,
        status: "inProgress",
        items: [],
      },
    ],
  };
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-describe-"));
  const store = new Store(root);
  const a = conversation("a", "thread-a");
  store.conversations = [a];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const internals = engine as any;
  internals.routes.set("thread-a", "a");
  const item = (method: string, id: string, extra = {}) =>
    internals.notification({
      method,
      params: {
        threadId: "thread-a",
        turnId: "turn",
        item: { id, type: "commandExecution", command: "ls", ...extra },
      },
    });
  return {
    root,
    store,
    engine,
    internals,
    a,
    item,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a description that arrives first waits for its command item and survives completion", async () => {
  const env = setup();
  try {
    env.internals.signals.toolDescription({
      threadId: "thread-a",
      callId: "call_1",
      description: "List repository files",
    });
    assert.equal(env.internals.pendingPatches.size, 1);
    env.item("item/started", "call_1");
    env.item("item/completed", "call_1", { exitCode: 0, status: "completed" });
    const [command] = env.a.turns[0].items;
    assert.equal(command.description, "List repository files");
    assert.equal(command.lifecycleStatus, "completed");
    assert.equal(env.internals.pendingPatches.size, 0);
    await env.engine.stop();
  } finally {
    env.close();
  }
});

test("a description after the item is written directly and never replaces one", () => {
  const env = setup();
  try {
    env.item("item/started", "call_2");
    env.internals.signals.toolDescription({
      threadId: "thread-a",
      callId: "call_2",
      description: "Run the unit tests",
    });
    env.internals.signals.toolDescription({
      threadId: "thread-a",
      callId: "call_2",
      description: "Something else",
    });
    assert.equal(env.a.turns[0].items[0].description, "Run the unit tests");
    assert.equal(env.internals.pendingPatches.size, 0);
  } finally {
    env.close();
  }
});

test("a description only fits a command item", () => {
  const env = setup();
  try {
    env.internals.signals.toolDescription({
      threadId: "thread-a",
      callId: "call_3",
      description: "List files",
    });
    env.internals.notification({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "turn",
        item: { id: "call_3", type: "mcpToolCall" },
      },
    });
    assert.equal(env.a.turns[0].items[0].description, undefined);
    assert.equal(env.internals.pendingPatches.size, 0);
  } finally {
    env.close();
  }
});

test("unknown threads are not held; a child agent's thread goes to listening extensions with its parent", () => {
  const env = setup();
  try {
    env.a.turns[0].items.push({
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      receiverThreadIds: ["child-thread"],
    });
    const heard: any[] = [];
    env.internals.signals.toolDescription({
      threadId: "nobody",
      callId: "c",
      description: "x",
    });
    assert.equal(env.internals.pendingPatches.size, 0);
    env.engine.extensions.add({
      id: "descriptions",
      onGatewaySignal: (signal, target) =>
        heard.push({
          type: signal.type,
          parent: target.parent?.id,
          conversation: target.conversation?.id,
        }),
    });
    env.internals.signals.toolDescription({
      threadId: "child-thread",
      callId: "c",
      description: "Read README.md",
    });
    env.internals.signals.toolDescription({
      threadId: "thread-a",
      callId: "call_9",
      description: "List files",
    });
    assert.deepEqual(heard, [
      { type: "toolDescription", parent: "a", conversation: undefined },
      { type: "toolDescription", parent: undefined, conversation: "a" },
    ]);
  } finally {
    env.close();
  }
});

test("a description reaches the child transcript projection, cleaned", () => {
  const [projected, other] = projectAgentItems([
    {
      id: "call",
      type: "commandExecution",
      description: "Show\u202e uncommitted changes",
    },
    { id: "m", type: "agentMessage", description: "not a command" },
  ]);
  assert.equal(projected.description, "Show uncommitted changes");
  assert.equal(other.description, undefined);
});
