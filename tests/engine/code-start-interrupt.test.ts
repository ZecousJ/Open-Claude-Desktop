import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { interruptExpectedTurn } from "../../electron/conversations/interrupt-target";
import {
  CodeSendCancelled,
  CodeSendStart,
} from "../../electron/engine/code-send-start";
import { applyTurnEvent } from "../../electron/engine/engine-events";
import { interrupt } from "../../electron/engine/engine-handoff";
import { send } from "../../electron/engine/engine-send";
import type { InterruptTarget } from "../../shared/interrupt-target";
import type { Conversation } from "../../shared/types";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(
  pause:
    | "beforeTurn"
    | "prepareTurn"
    | "turn/start"
    | "turn/interrupt" = "prepareTurn",
) {
  const conversation: Conversation = {
    id: "code",
    title: "Code",
    mode: "code",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 1,
    cwd: os.tmpdir(),
    providerId: "provider",
    model: "model",
    pinned: false,
    archived: false,
    turns: [],
  };
  const arrived = deferred(),
    gate = deferred();
  const calls: [string, unknown][] = [];
  const pauseAt = async (phase: string) => {
    if (phase !== pause) return;
    arrived.release();
    await gate.promise;
  };
  const store = {
    root: os.tmpdir(),
    projects: [],
    conversations: [conversation],
    settings: { providers: [{ id: "provider" }] },
    conversation: () => conversation,
    flush() {},
  };
  const engine: ThisParameterType<typeof send> = {
    store,
    environment: { kind: "local" },
    startedModelEfforts: [],
    safeguardModels: new Map(),
    routes: new Map(),
    defaultWorkspace: os.tmpdir(),
    assertMcpAvailable() {},
    elsewhereFor() {},
    elsewhere() {},
    assertSendable() {},
    assertIdle() {},
    assertExtensions() {},
    canQueue: () => false,
    dropWebSearch: () => pauseAt("beforeTurn"),
    sendCwd: () => os.tmpdir(),
    policy: () => ({ webSearch: true }),
    ensure: async () => {},
    syncRequestOptions: async () => {},
    windowsSandbox: { ensureReady: async () => {} },
    sandboxSetupFolder: () => os.tmpdir(),
    changed() {},
    threadOptions: () => ({}),
    turnContext: () => ({}),
    turnExtras: () => ({}),
    ensureThread: async () => {},
    clearApprovals() {},
    recordOutputFiles() {},
    refusalText() {},
    steers: new Map(),
    extensions: {
      prepareTurn: () => pauseAt("prepareTurn"),
    },
    rpc: {
      connected: true,
      async call(name: string, params: unknown) {
        calls.push([name, params]);
        await pauseAt(name);
        if (name === "turn/start") return { turn: { id: "native-turn" } };
        return {};
      },
    },
    interrupt(id: string) {
      return interrupt.call(engine, id);
    },
  } as never;
  const target = (): InterruptTarget => {
    const turn = conversation.turns.at(-1)!;
    return {
      ...(turn.id.startsWith("pending-")
        ? { kind: "starting" }
        : { threadId: conversation.threadId }),
      turnId: turn.id,
      turnCreatedAt: turn.createdAt,
      conversationCreatedAt: conversation.createdAt,
    };
  };
  return {
    conversation,
    store,
    engine,
    arrived,
    gate,
    calls,
    target,
    send: (codeSendStart?: CodeSendStart) =>
      send.call(
        engine,
        {
          conversationId: conversation.id,
          mode: "code",
          text: "draft",
          attachments: [],
          providerId: "provider",
          model: "model",
        },
        undefined,
        false,
        { newTaskResolved: true, current: () => true, codeSendStart },
      ),
    stop: (expected = target()) =>
      interruptExpectedTurn(
        { store, engine, accountGeneration: () => 1 },
        conversation.id,
        expected,
      ),
  };
}

test("pre-dispatch failures carry proof while turn/start failures remain ambiguous", async () => {
  const before = fixture("turn/start");
  before.engine.ensureThread = async () => { throw Error("resume timeout"); };
  await assert.rejects(before.send(new CodeSendStart("uuid")), /resume timeout/);
  assert.equal(before.conversation.turns[0].status, "failed");
  assert.equal(before.conversation.turns[0].undispatchedCodeSendUuid, "uuid");
  assert.deepEqual(before.calls, []);

  const after = fixture("beforeTurn");
  after.engine.rpc!.call = async () => { throw Error("start timeout"); };
  const sending = after.send(new CodeSendStart("uuid"));
  await after.arrived.promise;
  after.gate.release();
  await assert.rejects(sending, /start timeout/);
  assert.equal(after.conversation.turns[0].status, "failed");
  assert.equal(after.conversation.turns[0].undispatchedCodeSendUuid, undefined);
});

test("Stop during prepareTurn prevents turn/start and retains the interrupted input", async () => {
  const f = fixture();
  const send = f.send();
  const cancelled = assert.rejects(send, CodeSendCancelled);
  try {
    await f.arrived.promise;
    assert.deepEqual(await f.stop(), { status: "accepted" });
    assert.equal(f.conversation.turns[0].status, "interrupted");
    assert.equal(f.conversation.turns[0].userStopped, true);
    assert.equal(f.conversation.turns[0].prompt, "draft");
  } finally {
    f.gate.release();
    await cancelled;
  }
  assert.equal(
    f.calls.some(
      ([name]) => name === "turn/start" || name === "turn/interrupt",
    ),
    false,
  );
});

test("a native Stop before a provisional turn exists cancels only that send", async () => {
  const f = fixture("beforeTurn");
  const start = new CodeSendStart();
  const cancelled = assert.rejects(f.send(start), CodeSendCancelled);
  await f.arrived.promise;
  assert.deepEqual(f.conversation.turns, []);
  assert.deepEqual(await start.stop(), { status: "accepted" });
  assert.equal(start.cancelledBeforeDispatch, true);
  f.gate.release();
  await cancelled;
  assert.deepEqual(f.calls, []);
  assert.equal((await f.send()).turns.at(-1)?.id, "native-turn");
});

test("a native Stop keeps the held input without adding a second provisional row", async () => {
  const f = fixture();
  const start = new CodeSendStart();
  const cancelled = assert.rejects(f.send(start), CodeSendCancelled);
  await f.arrived.promise;
  assert.equal(f.conversation.turns.at(-1)?.prompt, "draft");
  assert.deepEqual(await start.stop(), { status: "accepted" });
  assert.deepEqual(await start.stop(), { status: "accepted" });
  assert.deepEqual(f.conversation.turns, []);
  f.gate.release();
  await cancelled;
  assert.deepEqual(f.calls, []);
});

test("Stop with a provisional ID waits for the exact dispatched turn, even across the ID change", async () => {
  const f = fixture("turn/start");
  const sending = f.send();
  await f.arrived.promise;
  const expected = f.target();
  const stopping = f.stop(expected);
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ["turn/start"],
  );
  assert.equal(f.conversation.turns[0].status, "inProgress");
  f.gate.release();
  await sending;
  assert.deepEqual(await stopping, { status: "accepted" });
  assert.deepEqual(
    f.calls.filter(([name]) => name === "turn/interrupt"),
    [["turn/interrupt", { threadId: "thread", turnId: "native-turn" }]],
  );
  assert.equal(f.conversation.turns[0].status, "inProgress");
});

test("Stop waiting for a real ID cannot interrupt a replacement turn", async () => {
  const f = fixture("turn/start");
  const sending = assert.rejects(f.send(), /session changed/);
  await f.arrived.promise;
  const stopping = f.stop();
  const next = { ...f.conversation.turns[0], id: "newer-turn" };
  f.conversation.turns.push(next);
  f.gate.release();
  await sending;
  assert.deepEqual(await stopping, { status: "mismatch" });
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ["turn/start"],
  );
  assert.equal(next.status, "inProgress");
});

test("a starting target in transit still selects the same turn after start replies", async () => {
  const f = fixture("turn/start");
  const sending = f.send();
  await f.arrived.promise;
  const expected = f.target();
  f.gate.release();
  await sending;
  assert.equal(f.conversation.turns[0].id, "native-turn");
  assert.deepEqual(await f.stop(expected), { status: "accepted" });
  assert.deepEqual(
    f.calls.filter(([name]) => name === "turn/interrupt"),
    [["turn/interrupt", { threadId: "thread", turnId: "native-turn" }]],
  );
});

test("the interrupted notification is intentional before Stop RPC acknowledgement", async () => {
  const f = fixture("turn/interrupt");
  await f.send();
  const stopping = f.stop();
  await f.arrived.promise;
  const turn = f.conversation.turns[0];
  assert.equal(turn.status, "inProgress");
  assert.equal(turn.userStopped, undefined);
  assert.equal(
    applyTurnEvent.call(f.engine, f.conversation, turn, "turn/completed", {
      turn: { id: turn.id, status: "interrupted" },
    }),
    true,
  );
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.userStopped, true);
  f.gate.release();
  assert.deepEqual(await stopping, { status: "accepted" });
});

test("Cowork marks a Stop in the first interrupted notification", async () => {
  const f = fixture("turn/interrupt");
  f.conversation.mode = "cowork";
  const turn = {
    id: "native-turn", status: "inProgress" as const, prompt: "Task",
    attachments: [], createdAt: 1, items: [],
  };
  f.conversation.turns.push(turn);
  const stopping = interrupt.call(f.engine, f.conversation.id);
  await f.arrived.promise;
  try {
    assert.equal(applyTurnEvent.call(f.engine, f.conversation, turn, "turn/completed", {
      turn: { id: turn.id, status: "interrupted" },
    }), true);
    assert.equal(f.conversation.turns[0].status, "interrupted");
    assert.equal(f.conversation.turns[0].userStopped, true);
  } finally {
    f.gate.release();
    await stopping;
  }
});
