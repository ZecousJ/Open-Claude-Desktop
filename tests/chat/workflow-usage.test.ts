import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { Engine } from "../../electron/engine/engine";
import { applyAgentUsage } from "../../shared/workflow-usage";
import type { Conversation } from "../../shared/types";
function conversation(): Conversation {
  return {
    id: "parent",
    title: "Fixture",
    mode: "code",
    providerId: "default",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "parent-thread",
    turns: [
      {
        id: "turn",
        prompt: "fixture",
        attachments: [],
        createdAt: 1,
        status: "completed",
        items: [
          {
            id: "spawn",
            type: "collabAgentToolCall",
            receiverThreadIds: ["child-thread"],
            status: "completed",
          },
        ],
      },
    ],
  };
}
test("child usage counters are cumulative and never counted twice", () => {
  const c = conversation();
  assert.equal(applyAgentUsage(c, "other", 12), false);
  assert.equal(applyAgentUsage(c, "child-thread", 1200), true);
  assert.equal(applyAgentUsage(c, "child-thread", 1200), false);
  assert.equal(applyAgentUsage(c, "child-thread", 900), false);
  assert.equal(applyAgentUsage(c, "child-thread", 1300), true);
  assert.equal(c.turns[0].items[0].agentTokenUsage?.["child-thread"], 1300);
  const native = { ...conversation(), id: "native" };
  native.turns[0].items = [
    {
      id: "child",
      type: "subAgentActivity",
      agentThreadId: "child-thread",
      kind: "started",
    },
  ];
  assert.equal(applyAgentUsage(native, "child-thread", 900), true);
  assert.equal(native.turns[0].items[0].agentTokenUsage?.["child-thread"], 900);
});
test("native child token event updates only its authorized parent conversation", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-workflow-usage-"),
  );
  try {
    const store = new Store(root),
      c = conversation();
    store.conversations = [c];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    (engine as any).notification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "unknown",
        turnId: "x",
        tokenUsage: { total: { totalTokens: 200 } },
      },
    });
    assert.equal(c.turns[0].items[0].agentTokenUsage, undefined);
    (engine as any).notification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "child-thread",
        turnId: "x",
        tokenUsage: { total: { totalTokens: 12345 } },
      },
    });
    assert.equal(c.turns[0].items[0].agentTokenUsage?.["child-thread"], 12345);
    store.flush();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
