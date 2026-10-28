import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";
function parent(id: string, threadId: string): Conversation {
  return {
    id,
    title: id,
    mode: "code",
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId,
    turns: [
      {
        id: "turn",
        prompt: "Parent request",
        attachments: [],
        createdAt: 1,
        status: "inProgress",
        items: [],
      },
    ],
  };
}
test("child prompt signals match only an active parent thread and call ID, in either arrival order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-routing-"));
  try {
    const store = new Store(root),
      a = parent("a", "thread-a"),
      b = parent("b", "thread-b");
    store.conversations = [a, b];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    const internals = engine as any;
    internals.routes.set("thread-a", "a");
    internals.routes.set("thread-b", "b");
    internals.captureAgentPrompt({
      parentThreadId: "wrong",
      callId: "child-a",
      message: "Private A",
    });
    internals.captureAgentPrompt({
      parentThreadId: "thread-a",
      callId: "child-a",
      message: "Private A",
      model: "model-a",
    });
    internals.notification({
      method: "item/started",
      params: {
        threadId: "thread-b",
        turnId: "turn",
        item: {
          id: "child-a",
          type: "subAgentActivity",
          agentThreadId: "agent-b",
          kind: "started",
        },
      },
    });
    assert.equal(b.turns[0].items[0].agentPrompt, undefined);
    internals.notification({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "turn",
        item: {
          id: "child-a",
          type: "subAgentActivity",
          agentThreadId: "agent-a",
          kind: "started",
        },
      },
    });
    assert.equal(a.turns[0].items[0].agentPrompt, "Private A");
    assert.equal(a.turns[0].items[0].agentModel, "model-a");
    internals.notification({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "turn",
        item: {
          id: "child-later",
          type: "subAgentActivity",
          agentThreadId: "agent-later",
          kind: "started",
        },
      },
    });
    internals.captureAgentPrompt({
      parentThreadId: "thread-a",
      callId: "child-later",
      message: "Later A",
    });
    assert.equal(a.turns[0].items[1].agentPrompt, "Later A");
    internals.captureAgentPrompt({
      parentThreadId: "thread-a",
      callId: "never-arrives",
      message: "Discard on stop",
    });
    assert.equal(internals.pendingAgentPrompts.size, 1);
    await engine.stop();
    assert.equal(internals.pendingAgentPrompts.size, 0);
    store.flush();
    const restored = new Store(root);
    assert.equal(
      restored.conversation("a").turns[0].items[0].agentPrompt,
      "Private A",
    );
    assert.equal(
      restored.conversation("b").turns[0].items[0].agentPrompt,
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
