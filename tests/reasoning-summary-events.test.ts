import assert from "node:assert/strict";
import test from "node:test";
import {
  applyItemEvent,
  applyTurnEvent,
  notification,
} from "../electron/engine/engine-events";
import { recordItemLifecycle } from "../shared/activity";
import type { Conversation, Item, Turn } from "../shared/types";

function turn(id = "active", status: Turn["status"] = "inProgress"): Turn {
  return { id, status, prompt: "", attachments: [], items: [], createdAt: 1 };
}

// Exercise real notification routing and lifecycle handlers without starting an
// Engine, a model, filesystem capture, timers, or network services.
function harness(turns = [turn()]) {
  const conversation = {
    id: "conversation",
    threadId: "thread",
    turns,
    updatedAt: 1,
  } as Conversation;
  let changes = 0;
  const context = {
    firstOutput: new Map(),
    sides: { chatOfThread: () => undefined },
    workflowThreads: new Map(),
    routes: new Map([["thread", conversation.id]]),
    store: { conversations: [conversation] },
    applyTurnEvent,
    applyItemEvent,
    signals: { reported() {} },
    pendingPatches: { apply() {} },
    extensions: { recordItem: (_: Conversation, item: Item) => item },
    agentRoutes: new Map(),
    changed() {
      changes++;
    },
  } as any;
  const send = (method: string, params: Record<string, unknown>) =>
    notification.call(context, {
      method,
      params: { threadId: "thread", turnId: "active", ...params },
    });
  const delta = (params: Record<string, unknown> = {}) =>
    send("item/reasoning/summaryTextDelta", {
      itemId: "reason",
      summaryIndex: 0,
      delta: "text",
      ...params,
    });
  const item = (completed: boolean, summary: string[] = []) =>
    send(completed ? "item/completed" : "item/started", {
      item: { id: "reason", type: "reasoning", summary },
    });
  return { conversation, context, send, delta, item, changes: () => changes };
}

test("summary before start survives repeated empty starts and appends by section", () => {
  const h = harness();
  h.delta({ summaryIndex: 2, delta: "third" });
  h.delta({ delta: "first" });
  h.item(false);
  h.item(false);
  h.delta({ delta: " section" });
  h.delta({ summaryIndex: 1, delta: "second" });
  const item = h.conversation.turns[0].items[0];
  assert.deepEqual(item.summary, ["first section", "second", "third"]);
  assert.equal(item.lifecycleStatus, "inProgress");
  assert.equal(h.changes(), 6);
});

test("start before delta, empty deltas, and valid upper index boundary", () => {
  const h = harness();
  h.item(false);
  h.delta({ delta: "" });
  assert.deepEqual(h.conversation.turns[0].items[0].summary, [""]);
  h.delta({ summaryIndex: 1023, delta: "last" });
  const summary = h.conversation.turns[0].items[0].summary!;
  assert.equal(summary.length, 1024);
  assert.equal(summary[1023], "last");
  assert.ok(summary.every((text) => typeof text === "string"));
});

test("completion snapshots are authoritative, including empty and repeated completion", () => {
  const h = harness();
  h.delta();
  h.item(true, ["final"]);
  h.item(false);
  assert.deepEqual(h.conversation.turns[0].items[0].summary, ["final"]);
  assert.equal(h.conversation.turns[0].items[0].lifecycleStatus, "completed");
  const before = h.changes();
  h.delta({ delta: "late" });
  assert.equal(h.changes(), before);
  assert.deepEqual(h.conversation.turns[0].items[0].summary, ["final"]);
  h.item(true);
  h.item(true);
  assert.deepEqual(h.conversation.turns[0].items[0].summary, []);
});

test("nonempty start snapshots and other item types retain normal merge behavior", () => {
  const t = turn();
  recordItemLifecycle(
    t,
    { id: "reason", type: "reasoning", summary: ["old"] },
    false,
  );
  recordItemLifecycle(
    t,
    { id: "reason", type: "reasoning", summary: ["new"] },
    false,
  );
  assert.deepEqual(t.items[0].summary, ["new"]);
  recordItemLifecycle(
    t,
    { id: "other", type: "agentMessage", summary: ["old"] },
    false,
  );
  recordItemLifecycle(
    t,
    { id: "other", type: "agentMessage", summary: [] },
    false,
  );
  assert.deepEqual(t.items[1].summary, []);
});

test("malformed summary payloads are inert, including reconnect state", () => {
  const invalid: Record<string, unknown>[] = [
    ...[
      -1,
      0.5,
      NaN,
      Infinity,
      1024,
      2 ** 32,
      Number.MAX_SAFE_INTEGER,
      "0",
      null,
      undefined,
    ].map((summaryIndex) => ({ summaryIndex })),
    ...[null, undefined, 42, {}, []].map((delta) => ({ delta })),
    ...[null, undefined, 42, "", "   ", {}].map((itemId) => ({ itemId })),
  ];
  for (const params of invalid) {
    const t = turn();
    t.reconnecting = "Retrying";
    t.reconnectCause = "overloaded";
    const h = harness([t]);
    const before = structuredClone(h.conversation);
    h.delta(params);
    assert.deepEqual(h.conversation, before);
    assert.equal(h.changes(), 0);
  }
});

test("summary events never fall back from unknown or missing turn IDs", () => {
  const h = harness([turn("earlier"), turn()]);
  for (const turnId of ["unknown", "", " ", undefined, null, 7]) {
    h.delta({ turnId });
  }
  assert.equal(h.changes(), 0);
  assert.ok(h.conversation.turns.every((t) => t.items.length === 0));
  h.delta({ turnId: "earlier" });
  assert.deepEqual(h.conversation.turns[0].items[0].summary, ["text"]);
  assert.equal(h.conversation.turns[1].items.length, 0);
  h.delta();
  assert.deepEqual(h.conversation.turns[1].items[0].summary, ["text"]);
});

test("unrelated events keep latest-turn fallback behavior", () => {
  const h = harness([turn("earlier"), turn()]);
  h.send("item/agentMessage/delta", {
    turnId: "unknown",
    itemId: "message",
    delta: "hello",
  });
  assert.equal(h.conversation.turns[0].items.length, 0);
  assert.equal(h.conversation.turns[1].items[0].text, "hello");
});

test("summary fragments cannot revive terminal turns or items", () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const terminal = turn("old", status);
    const active = turn();
    const h = harness([terminal, active]);
    const before = structuredClone(h.conversation);
    h.delta({ turnId: "old" });
    assert.deepEqual(h.conversation, before);
    assert.equal(h.changes(), 0);
    h.delta();
    h.conversation.turns[1].items[0].lifecycleStatus = status;
    const completed = structuredClone(h.conversation);
    h.delta({ delta: "late" });
    assert.deepEqual(h.conversation, completed);
    assert.equal(h.changes(), 1);
  }
});

test("summary fragments do not modify a different item type or terminal legacy item", () => {
  for (const existing of [
    {
      id: "reason",
      type: "agentMessage",
      lifecycleStatus: "inProgress",
      text: "keep",
    },
    { id: "reason", type: "reasoning", status: "completed", summary: ["keep"] },
  ] as Item[]) {
    const t = turn();
    t.items.push(existing);
    const h = harness([t]);
    const before = structuredClone(h.conversation);
    h.delta();
    assert.deepEqual(h.conversation, before);
    assert.equal(h.changes(), 0);
  }
});

test("inactive native threads and unknown routes cannot receive summary fragments", () => {
  const h = harness();
  h.delta({ threadId: "unknown" });
  h.conversation.threadId = "replacement";
  h.delta();
  assert.equal(h.changes(), 0);
  assert.equal(h.conversation.turns[0].items.length, 0);
});

test("accepted summary clears reconnect state but direct mismatched turn calls are inert", () => {
  const t = turn();
  t.reconnecting = "Retrying";
  t.reconnectCause = "overloaded";
  const h = harness([t]);
  const params = {
    turnId: "unknown",
    itemId: "reason",
    summaryIndex: 0,
    delta: "x",
  };
  assert.equal(
    applyTurnEvent.call(
      h.context,
      h.conversation,
      t,
      "item/reasoning/summaryTextDelta",
      params,
    ),
    false,
  );
  assert.equal(t.reconnecting, "Retrying");
  h.delta();
  assert.equal(t.reconnecting, undefined);
  assert.equal(t.reconnectCause, undefined);
});

test("legacy sparse or malformed summary sections cannot crash starts or stringify into deltas", () => {
  for (const summary of [
    [null, "third"],
    [undefined, "third"],
    Array(2),
    [4],
    "invalid",
    { 0: "invalid" },
  ]) {
    const t = turn();
    t.items = [
      {
        id: "reason",
        type: "reasoning",
        summary,
        lifecycleStatus: "inProgress",
      } as any,
    ];
    const h = harness([t]);
    h.delta({ delta: "public" });
    assert.equal(t.items[0].summary![0], "public");
    h.item(false);
    assert.equal(t.items[0].summary![0], "public");
  }
  const t = turn();
  t.items = [
    {
      id: "reason",
      type: "reasoning",
      summary: [null, "third"],
      lifecycleStatus: "inProgress",
    } as any,
  ];
  assert.doesNotThrow(() =>
    recordItemLifecycle(
      t,
      { id: "reason", type: "reasoning", summary: [] },
      false,
    ),
  );
  assert.equal(t.items[0].summary![1], "third");
});
