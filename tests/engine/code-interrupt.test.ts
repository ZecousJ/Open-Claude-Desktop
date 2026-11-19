/** RPC/store fakes only: never starts an engine, model request, or process. */
import test from "node:test";
import assert from "node:assert/strict";
import { interrupt } from "../../electron/engine/engine-handoff";

function fixture() {
  const turn: any = {
    id: "turn",
    status: "inProgress",
    items: [
      { type: "agentMessage", id: "text", text: "Partial answer" },
      { type: "commandExecution", id: "command" },
    ],
  };
  const conversation: any = {
    id: "code",
    mode: "code",
    threadId: "thread",
    turns: [turn],
  };
  let actual = conversation;
  let source: (method: string, params: any) => Promise<any> = async () => ({});
  const calls: any[] = [],
    notifications: any[] = [],
    aborted: string[] = [];
  let flushed = 0;
  const store = { conversation: () => actual, flush: () => flushed++ };
  const engine: any = {
    store,
    elsewhereFor: () => undefined,
    rpc: {
      call: async (method: string, params: any) => {
        calls.push([method, params]);
        return source(method, params);
      },
    },
    gateway: { abortThread: (id: string) => aborted.push(id) },
    notification: (notification: any) => notifications.push(notification),
    changed() {},
  };
  return {
    engine,
    turn,
    conversation,
    calls,
    notifications,
    aborted,
    run: () => interrupt.call(engine, "code"),
    source: (fn: typeof source) => {
      source = fn;
    },
    replace: () => {
      actual = structuredClone(conversation);
    },
    get flushed() {
      return flushed;
    },
  };
}

test("Code Stop requires an RPC and propagates disconnection without fabricated completion", async () => {
  for (const missing of [true, false]) {
    const f = fixture(),
      before = structuredClone(f.conversation);
    if (missing) delete f.engine.rpc;
    else
      f.source(async () => {
        throw Error("connection lost");
      });
    await assert.rejects(
      f.run(),
      missing ? /not connected/ : /connection lost/,
    );
    assert.deepEqual(f.conversation, before);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.flushed, 0);
    assert.deepEqual(f.aborted, ["thread"]);
  }
});

test("Code acceptance targets exact turn, retains partial output, deduplicates only owned terminal processes", async () => {
  const f = fixture(),
    before = structuredClone(f.conversation);
  f.source(async (method, params) =>
    method === "thread/backgroundTerminals/list"
      ? {
          data: [
            { itemId: "command", processId: "owned" },
            { itemId: "command", processId: "owned" },
            { itemId: "other-turn-command", processId: "unrelated" },
            { itemId: "command", processId: "" },
          ],
          ...(!params.cursor ? { nextCursor: "page2" } : {}),
        }
      : {},
  );
  await f.run();
  assert.deepEqual(f.calls[0], [
    "turn/interrupt",
    { threadId: "thread", turnId: "turn" },
  ]);
  assert.deepEqual(
    f.calls.filter(([name]) => name.endsWith("/terminate")),
    [
      [
        "thread/backgroundTerminals/terminate",
        { threadId: "thread", processId: "owned" },
      ],
    ],
  );
  before.turns[0].userStopped = true;
  assert.deepEqual(f.conversation, before);
  assert.equal(f.notifications.length, 0);
});

test("accepted Stop marks an interruption that arrived before its acknowledgement", async () => {
  const f = fixture();
  f.source(async (method) => {
    if (method === "turn/interrupt") f.turn.status = "interrupted";
    return {};
  });
  await f.run();
  assert.equal(f.turn.userStopped, true);
  assert.equal(f.turn.status, "interrupted");
  assert.equal(f.flushed, 1);
});

test("Code terminal cleanup failures remain visible and owned upstream still aborts", async () => {
  for (const failAt of ["list", "terminate"]) {
    const f = fixture();
    f.source(async (method) => {
      if (method.endsWith(`/${failAt}`)) throw Error("cleanup failed");
      return method.endsWith("/list")
        ? { data: [{ itemId: "command", processId: "owned" }] }
        : {};
    });
    await assert.rejects(f.run(), /cleanup failed/);
    assert.equal(f.turn.status, "inProgress");
    assert.equal(f.notifications.length, 0);
    assert.deepEqual(f.aborted, ["thread"]);
  }
});

test("Code repeated and endlessly distinct pagination fail explicitly instead of hanging", async () => {
  for (const repeating of [true, false]) {
    const f = fixture();
    let pages = 0;
    f.source(async (method) =>
      method.endsWith("/list")
        ? { data: [], nextCursor: repeating ? "same" : String(++pages) }
        : {},
    );
    await assert.rejects(f.run(), repeating ? /repeated cursor/ : /page limit/);
    assert.equal(
      f.calls.filter(([method]) => method.endsWith("/list")).length,
      repeating ? 2 : 100,
    );
    assert.equal(f.turn.status, "inProgress");
    assert.deepEqual(f.aborted, ["thread"]);
  }
});

test("Code replacement, account, RPC, thread, new turn and changed turn ID suppress stale cleanup", async () => {
  for (const change of [
    "replacement",
    "account",
    "rpc",
    "thread",
    "turn",
    "turnId",
  ]) {
    for (const phase of ["turn/interrupt", "thread/backgroundTerminals/list"]) {
      const f = fixture();
      f.source(async (method) => {
        if (method === phase) {
          if (change === "replacement") f.replace();
          if (change === "account") f.engine.store = { ...f.engine.store };
          if (change === "rpc")
            f.engine.rpc = {
              call: async () => {
                throw Error("replacement RPC must not be used");
              },
            };
          if (change === "thread") f.conversation.threadId = "new-thread";
          if (change === "turn")
            f.conversation.turns.push({ ...f.turn, id: "new-turn" });
          if (change === "turnId") f.turn.id = "reused-object-new-turn";
        }
        return { data: [{ itemId: "command", processId: "owned" }] };
      });
      await f.run();
      assert.equal(
        f.calls.some(([method]) => method.endsWith("/terminate")),
        false,
        `${change} during ${phase}`,
      );
      assert.deepEqual(f.aborted, []);
      assert.equal(f.notifications.length, 0);
    }
  }
});

test("Code no-active-turn errors require exact terminal history before reconciliation", async () => {
  for (const status of ["inProgress", "completed", "failed", "interrupted"]) {
    const f = fixture();
    f.source(async (method) => {
      if (method === "turn/interrupt")
        throw Error("no active turn to interrupt");
      if (method === "thread/read")
        return {
          thread: { id: "thread", turns: [{ id: "turn", status, items: [] }] },
        };
      return { data: [] };
    });
    if (status === "inProgress") {
      await assert.rejects(f.run(), /no active turn/);
      assert.equal(f.notifications.length, 0);
    } else {
      await f.run();
      assert.deepEqual(f.notifications, [
        {
          method: "turn/completed",
          params: {
            threadId: "thread",
            turn: { id: "turn", status, items: [] },
          },
        },
      ]);
      assert.equal(f.flushed, 1);
    }
  }
});

test("Code no-active-turn cannot use another thread or another turn's completed history", async () => {
  for (const mismatch of ["thread", "turn"]) {
    const f = fixture();
    f.source(async (method) => {
      if (method === "turn/interrupt")
        throw Error("no active turn to interrupt");
      if (method === "thread/read")
        return {
          thread: {
            id: mismatch === "thread" ? "other-thread" : "thread",
            turns: [
              {
                id: mismatch === "turn" ? "other-turn" : "turn",
                status: "completed",
                items: [],
              },
            ],
          },
        };
      throw Error("unverified history must not trigger cleanup");
    });
    await assert.rejects(f.run(), /no active turn/);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.flushed, 0);
    assert.equal(f.turn.status, "inProgress");
    assert.deepEqual(f.aborted, ["thread"]);
  }
});

test("Code completed turns and repository setup abort retain existing behavior", async () => {
  const completed = fixture();
  completed.turn.status = "completed";
  await completed.run();
  assert.deepEqual(completed.calls, []);
  const setup = fixture();
  let abortedSetup = 0;
  setup.engine.setupAbort = {
    conversationId: "code",
    abort: { abort: () => abortedSetup++ },
  };
  delete setup.engine.rpc;
  await setup.run();
  assert.equal(abortedSetup, 1);
  assert.deepEqual(setup.calls, []);
  assert.deepEqual(setup.aborted, []);
});
