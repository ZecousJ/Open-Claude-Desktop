import assert from "node:assert/strict";
import test from "node:test";
import {
  applyItemEvent,
  applyTurnEvent,
  notification,
} from "../electron/engine/engine-events";
import {
  finishTurn,
  itemIsRunning,
  recordItemLifecycle,
  recordMcpProgress,
} from "../shared/activity";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { convertCodeTranscript } from "../electron/official-ui/native/code-transcript";
import type { Conversation, Item, Turn } from "../shared/types";

function turn(id = "active", status: Turn["status"] = "inProgress"): Turn {
  return {
    id,
    status,
    prompt: "fixture",
    attachments: [],
    items: [],
    createdAt: 1,
  };
}
function harness(turns = [turn()]) {
  const c = {
    id: "conversation",
    threadId: "thread",
    mode: "code",
    cwd: "/fixture",
    title: "Fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
  } as Conversation;
  let changes = 0;
  const context = {
    firstOutput: new Map(),
    sides: { chatOfThread: () => undefined },
    workflowThreads: new Map(),
    routes: new Map([["thread", c.id]]),
    store: { conversations: [c] },
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
  const send = (method: string, params: Record<string, unknown> = {}) =>
    notification.call(context, {
      method,
      params: { threadId: "thread", turnId: "active", ...params },
    });
  const progress = (params: Record<string, unknown> = {}) =>
    send("item/mcpToolCall/progress", {
      itemId: "tool",
      message: "opening",
      ...params,
    });
  const snapshot = (
    completed: boolean,
    patch: Partial<Item> = {},
    params: Record<string, unknown> = {},
  ) =>
    send(completed ? "item/completed" : "item/started", {
      item: {
        id: "tool",
        type: "mcpToolCall",
        server: "wiki",
        tool: "lookup",
        arguments: { query: "fixture" },
        status: completed ? "completed" : "inProgress",
        ...patch,
      },
      ...params,
    });
  return { c, context, send, progress, snapshot, changes: () => changes };
}

test("out-of-order progress survives empty repeated starts and terminal snapshots cannot be rewritten by late starts", () => {
  const h = harness();
  h.progress();
  const startedAt = h.c.turns[0].items[0].startedAt;
  h.snapshot(false, { progress: "" });
  h.snapshot(false, { progress: "" });
  assert.equal(h.c.turns[0].items[0].progress, "opening");
  assert.equal(h.c.turns[0].items[0].startedAt, startedAt);
  h.snapshot(true, {
    result: { content: [{ type: "text", text: "final" }], isError: true },
  });
  const final = structuredClone(h.c),
    changes = h.changes();
  h.snapshot(false, {
    tool: "wrong",
    arguments: {},
    result: null,
    error: null,
  });
  h.progress({ message: "late" });
  assert.deepEqual(h.c, final);
  assert.equal(h.changes(), changes);
});

test("completion snapshots remain authoritative including empty final content", () => {
  const h = harness();
  h.snapshot(false);
  h.snapshot(true, { result: { content: [{ type: "text", text: "first" }] } });
  h.snapshot(true, { result: { content: [] } });
  const converted = convertCodeTranscript(h.c);
  assert.deepEqual(
    (converted.rows.at(-1)!.message.content as any[])[0].content,
    [],
  );
});

for (const method of [
  "item/mcpToolCall/progress",
  "item/started",
  "item/completed",
])
  test(`${method} requires exact turn identity and never falls back to latest`, () => {
    const h = harness([turn("earlier"), turn()]);
    for (const turnId of ["unknown", "", " ", undefined, null, 7]) {
      h.send(method, {
        turnId,
        itemId: "tool",
        message: "invalid",
        item: { id: "tool", type: "mcpToolCall" },
      });
    }
    assert.equal(h.changes(), 0);
    assert.ok(h.c.turns.every((t) => t.items.length === 0));
    h.send(method, {
      turnId: "earlier",
      itemId: "tool",
      message: "earlier",
      item: {
        id: "tool",
        type: "mcpToolCall",
        status: "completed",
        result: {},
      },
    });
    assert.equal(h.c.turns[0].items.length, 1);
    assert.equal(h.c.turns[1].items.length, 0);
  });

test("dynamic-tool snapshots also require exact turn identity", () => {
  const h = harness();
  for (const completed of [false, true])
    h.snapshot(completed, { type: "dynamicToolCall" }, { turnId: "wrong" });
  assert.equal(h.changes(), 0);
  assert.equal(h.c.turns[0].items.length, 0);
});

test("malformed and duplicate progress are inert, including reconnect state", () => {
  const h = harness();
  const t = h.c.turns[0];
  t.reconnecting = "Retrying";
  t.reconnectCause = "overloaded";
  const before = structuredClone(h.c);
  for (const itemId of ["", "  ", undefined, null, 42]) h.progress({ itemId });
  for (const message of [undefined, null, 42, {}, []]) h.progress({ message });
  assert.deepEqual(h.c, before);
  assert.equal(h.changes(), 0);
  h.progress();
  assert.equal(t.reconnecting, undefined);
  const changes = h.changes();
  t.reconnecting = "Retrying";
  h.progress();
  assert.equal(t.reconnecting, "Retrying");
  assert.equal(h.changes(), changes);
  h.progress({ message: "a".repeat(1500) });
  assert.equal(t.items[0].progress!.length, 1000);
});

test("invalid tool snapshot identity and same-ID different type do not change source or reconnect state", () => {
  const h = harness();
  const t = h.c.turns[0];
  t.items.push({
    id: "tool",
    type: "agentMessage",
    text: "original",
    lifecycleStatus: "inProgress",
  });
  t.reconnecting = "Retrying";
  t.reconnectCause = "overloaded";
  const before = structuredClone(h.c);
  for (const completed of [false, true]) {
    h.snapshot(completed);
    for (const id of ["", " ", null, undefined, 3])
      h.snapshot(completed, { id } as any);
  }
  h.progress();
  assert.deepEqual(h.c, before);
  assert.equal(h.changes(), 0);
});

for (const status of ["completed", "failed", "interrupted"] as const)
  test(`terminal ${status} turn rejects progress and new starts`, () => {
    const h = harness([turn("active", status)]);
    const before = structuredClone(h.c);
    h.progress();
    h.snapshot(false);
    assert.deepEqual(h.c, before);
    assert.equal(h.changes(), 0);
  });

test("inactive native threads and unknown routes never receive MCP events", () => {
  const h = harness();
  h.context.routes.set("old-thread", h.c.id);
  h.progress({ threadId: "old-thread" });
  h.snapshot(true, {}, { threadId: "old-thread" });
  h.progress({ threadId: "unrouted" });
  assert.equal(h.changes(), 0);
  assert.equal(h.c.turns[0].items.length, 0);
});

test("direct lifecycle helpers preserve terminal tools and legacy running status settles", () => {
  const t = turn();
  t.items = [
    { id: "tool", type: "mcpToolCall", status: "running", progress: "opening" },
  ];
  assert.equal(itemIsRunning(t.items[0]), true);
  assert.equal(recordMcpProgress(t, "tool", "next"), true);
  finishTurn(t, "interrupted");
  assert.equal(itemIsRunning(t.items[0]), false);
  const before = structuredClone(t);
  recordItemLifecycle(
    t,
    { id: "tool", type: "mcpToolCall", result: "stale", status: "running" },
    false,
  );
  assert.deepEqual(t, before);
  assert.equal(recordMcpProgress(t, "tool", "late"), false);
});

test("direct progress handler rejects mismatched turns without clearing reconnect state", () => {
  const h = harness();
  const t = h.c.turns[0];
  t.reconnecting = "Retrying";
  assert.equal(
    applyTurnEvent.call(h.context, h.c, t, "item/mcpToolCall/progress", {
      turnId: "wrong",
      itemId: "tool",
      message: "wrong",
    }),
    false,
  );
  assert.equal(t.reconnecting, "Retrying");
  assert.equal(t.items.length, 0);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
function native(c: Conversation) {
  const handlers = new Map<string, any>(),
    events: any[] = [],
    calls: string[] = [],
    logs: unknown[][] = [];
  let listener!: (event: any) => void;
  let account = "fixture-owner",
    generation = 1;
  const close = registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: account }),
      sessionIdentity: () => generation,
      isCurrent: () => true,
      localLoadConversation: async (id: string) =>
        id === c.id ? structuredClone(c) : undefined,
      localCall: async (name: string) => {
        calls.push(name);
        if (name === "snapshot") return { approvals: [] };
        throw Error("Unexpected mutation: " + name);
      },
      onEvent: (fn: any) => {
        listener = fn;
        return () => {};
      },
      log: (...args: unknown[]) => logs.push(args),
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (_domain: string, _event: string, payload: any) =>
      events.push(payload),
  } as any);
  return {
    handlers,
    events,
    calls,
    logs,
    close,
    emit: () =>
      listener({ type: "conversation", conversation: structuredClone(c) }),
    switchAccount: () => {
      account = "next-owner";
      generation++;
    },
  };
}

test("actual native history/live stream keeps one tool identity across progress, completion and reopened history without invoking tools", async () => {
  const h = harness();
  const n = native(h.c);
  try {
    h.progress();
    h.snapshot(false);
    n.emit();
    await settle();
    const id = "active:tool:tool:use";
    const first = n.events.find(
      (e) => e.type === "message" && e.message.uuid === id,
    );
    assert.equal(first.message.claudexToolProgress, "opening");
    assert.equal(first.message.message.content[0].name, "mcp__wiki__lookup");
    assert.ok(
      !n.events.some(
        (e) => e.type === "message" && e.message.uuid.endsWith(":result"),
      ),
    );
    h.progress({ message: "reading" });
    n.emit();
    await settle();
    assert.equal(
      n.events.filter((e) => e.type === "message" && e.message.uuid === id)
        .length,
      2,
    );
    const count = n.events.filter((e) => e.type === "message").length;
    n.emit();
    await settle();
    assert.equal(n.events.filter((e) => e.type === "message").length, count);
    h.snapshot(true, {
      result: {
        content: [{ type: "text", text: "finished" }],
        structuredContent: { rows: 2 },
        isError: true,
      },
    });
    finishTurn(h.c.turns[0], "completed");
    n.emit();
    await settle();
    const result = n.events.find(
      (e) => e.type === "message" && e.message.uuid.endsWith(":result"),
    );
    assert.equal(result.message.message.content[0].is_error, true);
    assert.deepEqual(result.message.mcpMeta, {
      structuredContent: { rows: 2 },
    });
    const history = await n.handlers.get("LocalSessions.getTranscript")(
      "local_conversation",
    );
    const live = new Map(n.events.filter((e) => e.type === "message")
      .map((e) => [e.message.uuid, e.message]));
    assert.deepEqual([...live.values()], history);
    assert.equal(n.events.at(-1)?.type, "close");
    const reopened = native(structuredClone(h.c));
    try {
      assert.deepEqual(
        await reopened.handlers.get("LocalSessions.getTranscript")(
          "local_conversation",
        ),
        history,
      );
    } finally {
      reopened.close();
    }
    assert.ok(n.calls.every((name) => name === "snapshot"));
    assert.deepEqual(n.logs, []);
  } finally {
    n.close();
  }
});

test("late source progress after tool completion does not emit replacement result", async () => {
  const h = harness();
  h.snapshot(true, { result: { content: [{ type: "text", text: "done" }] } });
  const n = native(h.c);
  try {
    n.emit();
    await settle();
    const count = n.events.filter((e) => e.type === "message").length;
    h.progress({ message: "late" });
    h.snapshot(false, { result: null });
    n.emit();
    await settle();
    assert.equal(n.events.filter((e) => e.type === "message").length, count);
  } finally {
    n.close();
  }
});

test("turn settlement without final tool snapshot cannot manufacture success", () => {
  const h = harness();
  h.progress();
  h.snapshot(false);
  finishTurn(h.c.turns[0], "completed");
  const { rows, unsupported } = convertCodeTranscript(h.c);
  assert.equal(rows.at(-1)!.uuid, `${h.c.turns[0].id}:tool:tool:use`);
  assert.deepEqual(unsupported, ["unknown-tool-status"]);
});

test("explicit item completion with absent status remains an observed empty completion", () => {
  const h = harness();
  h.progress();
  h.snapshot(false);
  h.snapshot(true, { status: undefined });
  finishTurn(h.c.turns[0], "completed");
  assert.equal(h.c.turns[0].items[0].status, "completed");
  const result = (
    convertCodeTranscript(h.c).rows.at(-1)!.message.content as any[]
  )[0];
  assert.equal(result.is_error, false);
  assert.deepEqual(result.content, []);
});

for (const status of [
  "unknown",
  "failed",
  "declined",
  "interrupted",
  "cancelled",
  "canceled",
])
  test(`statusless explicit completion preserves prior terminal status ${status}`, () => {
    const t = turn();
    t.items = [
      {
        id: "tool",
        type: "mcpToolCall",
        status,
        lifecycleStatus: "inProgress",
      },
    ];
    recordItemLifecycle(
      t,
      { id: "tool", type: "mcpToolCall", status: undefined },
      true,
    );
    assert.equal(
      t.items[0].status,
      status === "unknown" ? "completed" : status,
    );
    const h = harness([t]);
    const result = (
      convertCodeTranscript(h.c).rows.at(-1)!.message.content as any[]
    )[0];
    assert.equal(result.is_error, status !== "unknown");
    assert.deepEqual(result.content, []);
  });
