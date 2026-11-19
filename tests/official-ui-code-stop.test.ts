/** Actual native registration -> IPC compare-and-stop -> Engine.interrupt. Inert RPC only. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import { interrupt } from "../electron/engine/engine-handoff";
import { CodeSendStart, trackCodeSendStart } from "../electron/engine/code-send-start";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function fixture() {
  const turn = { id: "turn", createdAt: 2, status: "inProgress", items: [] };
  const c: any = {
    id: "code",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 2,
    title: "Code stop",
    mode: "code",
    cwd: "/inert",
    turns: [turn],
  };
  let actual = c,
    identity: object = {},
    loadGate: Promise<void> | undefined;
  let rpcCall: (name: string, args: any) => Promise<any> = async () => ({});
  const calls: any[] = [],
    rpcCalls: any[] = [],
    effects: string[] = [];
  const store = {
    conversation: (id: string) => {
      if (id !== "code" || !actual) throw Error("missing");
      return actual;
    },
    flush() {},
  };
  const engine: any = {
    store,
    elsewhereFor: () => undefined,
    rpc: {
      connected: true,
      call: async (name: string, args: any) => {
        rpcCalls.push([name, args]);
        return rpcCall(name, args);
      },
    },
    changed() {},
    gateway: { abortThread: (id: string) => effects.push(id) },
  };
  engine.interrupt = interrupt.bind(engine);
  const main: any = { store, engine, accountGeneration: () => identity };
  const ipc = new Map<string, any>(),
    native = new Map<string, any>();
  registerConversationTurnHandlers({
    context: main,
    handle: (name: string, fn: any) => ipc.set(name, fn),
    cli: {},
    resumable: {},
  } as any);
  let responseOverride: any;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => identity,
      localLoadConversation: async () => {
        const value = actual && structuredClone(actual);
        await loadGate;
        return value;
      },
      localCall: async (name: string, ...args: any[]) => {
        calls.push([name, ...args]);
        if (responseOverride) return responseOverride();
        return ipc.get(name)(...args);
      },
      onEvent: () => () => {},
    },
    on: (name: string, fn: any) => native.set(name, fn),
    emit() {},
  } as any);
  return {
    c,
    turn,
    engine,
    calls,
    rpcCalls,
    effects,
    run: (name = "interrupt") =>
      native.get("LocalSessions." + name)("local_code"),
    rpc: (fn: typeof rpcCall) => (rpcCall = fn),
    load: (gate: Promise<void>) => (loadGate = gate),
    activate: () => (identity = {}),
    replace: () => (actual = structuredClone(c)),
    remove: () => (actual = undefined),
    response: (fn: any) => (responseOverride = fn),
  };
}

for (const name of ["stop", "interrupt"])
  test(`${name} sends exact stable turn through actual IPC and engine without marking it complete`, async () => {
    const h = fixture();
    await h.run(name);
    assert.deepEqual(h.calls, [
      [
        "interrupt",
        "code",
        {
          turnId: "turn",
          turnCreatedAt: 2,
          conversationCreatedAt: 1,
          threadId: "thread",
        },
      ],
    ]);
    assert.deepEqual(h.rpcCalls, [
      ["turn/interrupt", { threadId: "thread", turnId: "turn" }],
    ]);
    assert.equal(h.turn.status, "inProgress");
  });

for (const state of ["completed", "failed", "interrupted", "empty"])
  test(`idle ${state} stop never dispatches an unbound stop`, async () => {
    const h = fixture();
    if (state === "empty") h.c.turns = [];
    else h.turn.status = state;
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.rpcCalls, []);
  });

for (const mutate of [
  (h: ReturnType<typeof fixture>) =>
    h.c.turns.push({ ...h.turn, id: "new", createdAt: 3 }),
  (h: ReturnType<typeof fixture>) => (h.c.threadId = "new-thread"),
  (h: ReturnType<typeof fixture>) => (h.c.createdAt = 5),
  (h: ReturnType<typeof fixture>) => (h.turn.createdAt = 7),
])
  test("delayed source read cannot stop a changed turn or branch", async () => {
    const h = fixture(),
      gate = deferred();
    h.load(gate.promise);
    const pending = h.run();
    mutate(h);
    gate.resolve();
    await assert.rejects(pending, /changed|not confirmed/);
    assert.equal(h.rpcCalls.length, 0);
  });

test("a terminal event while reading yields already-finished without a second stop", async () => {
  const h = fixture(),
    gate = deferred();
  h.load(gate.promise);
  const pending = h.run();
  h.turn.status = "completed";
  gate.resolve();
  await pending;
  assert.deepEqual(h.rpcCalls, []);
});

test("a provisional turn without a matching startup attempt cannot reach the RPC", async () => {
  const h = fixture();
  h.turn.id = "pending-provisional";
  await assert.rejects(h.run(), /not confirmed/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.rpcCalls, []);
});

for (const mutate of [
  (h: ReturnType<typeof fixture>) => (h.c.threadId = undefined),
  (h: ReturnType<typeof fixture>) => (h.turn.createdAt = NaN),
  (h: ReturnType<typeof fixture>) => (h.c.createdAt = undefined),
  (h: ReturnType<typeof fixture>) => (h.turn.status = "unknown"),
])
  test("unsupported or incomplete turn targets refuse instead of falling back to an unbound stop", async () => {
    const h = fixture();
    mutate(h);
    await assert.rejects(h.run(), /not ready/);
    assert.deepEqual(h.calls, []);
  });

for (const result of [
  undefined,
  {},
  { status: "mismatch" },
  { status: "invented" },
])
  test("unconfirmed stop result is a visible failure with no fallback or auto retry", async () => {
    const h = fixture();
    h.response(async () => result);
    await assert.rejects(h.run(), /not confirmed/);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.rpcCalls, []);
  });

test("simultaneous stop button and Escape share one in-flight exact stop", async () => {
  const h = fixture(),
    gate = deferred();
  h.rpc(async () => {
    await gate.promise;
    return {};
  });
  const one = h.run("stop"),
    two = h.run("interrupt");
  await new Promise((r) => setImmediate(r));
  assert.equal(h.rpcCalls.length, 1);
  gate.resolve();
  await Promise.all([one, two]);
  assert.equal(h.calls.length, 1);
});

test("coalesced failures remain errors; only an explicit later click retries the same target", async () => {
  const h = fixture(),
    gate = deferred();
  h.rpc(async () => {
    await gate.promise;
    throw Error("transport timeout");
  });
  const one = assert.rejects(h.run("stop"), /transport timeout/),
    two = assert.rejects(h.run(), /transport timeout/);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.rpcCalls.length, 1);
  gate.resolve();
  await Promise.all([one, two]);
  assert.equal(h.rpcCalls.length, 1);
  h.rpc(async () => ({}));
  await h.run();
  assert.equal(h.rpcCalls.length, 2);
});

for (const action of ["activate", "replace", "remove"] as const)
  test(`late stop result after ${action} cannot be accepted or clean up a replacement`, async () => {
    const h = fixture(),
      gate = deferred();
    h.rpc(async () => {
      await gate.promise;
      return {};
    });
    const pending = assert.rejects(h.run(), /changed|not confirmed/);
    await new Promise((r) => setImmediate(r));
    h[action]();
    gate.resolve();
    await pending;
    if (action !== "activate") assert.deepEqual(h.effects, []);
  });

test("account changes during a delayed read retire the stop before IPC", async () => {
  const h = fixture(),
    gate = deferred();
  h.load(gate.promise);
  const pending = assert.rejects(h.run(), /account changed/);
  h.activate();
  gate.resolve();
  await pending;
  assert.deepEqual(h.calls, []);
});

test("missing Code transport error reaches the actual native caller unchanged", async () => {
  const h = fixture();
  h.engine.rpc = undefined;
  await assert.rejects(h.run(), /not connected/);
  assert.equal(h.turn.status, "inProgress");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.rpcCalls, []);
});

for (const latestStatus of ["inProgress", "completed", "unknown"])
  test(`ambiguous active history with a ${latestStatus} tail never chooses an arbitrary turn`, async () => {
    const h = fixture();
    h.c.turns.push({ ...h.turn, id: "tail", status: latestStatus });
    await assert.rejects(h.run(), /ambiguous/);
    assert.deepEqual(h.calls, []);
  });

test("native stop interrupts a registered provisional turn", async () => {
  const h = fixture(); h.turn.id = "pending-provisional"; h.c.threadId = undefined;
  const start = new CodeSendStart();
  start.bind(() => true, () => { h.turn.status = "interrupted"; });
  trackCodeSendStart(h.c, h.turn as any, start);
  await h.run();
  assert.equal(h.turn.status, "interrupted");
  assert.deepEqual(h.rpcCalls, []);
  assert.deepEqual(h.calls[0][2], {kind: "starting", turnId: "pending-provisional", turnCreatedAt: 2, conversationCreatedAt: 1});
});
test("native stop rejects an unregistered provisional turn", async () => {
  const h = fixture(); h.turn.id = "pending-provisional";
  await assert.rejects(h.run(), /not confirmed/); assert.deepEqual(h.rpcCalls, []);
});
