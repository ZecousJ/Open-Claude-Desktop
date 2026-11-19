/** Startup/interrupt fixtures only. No real account, model, attachment or engine operation. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { Conversation } from "../shared/types";
const id = "11111111-1111-4111-8111-111111111111",
  key = `local_${id}`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture() {
  const handlers = new Map<string, any>(),
    calls: string[] = [];
  let identity = {},
    c: Conversation | undefined,
    loadGate: Promise<void> | undefined,
    sendGate: Promise<void> | undefined,
    interruptGate: Promise<void> | undefined,
    sendError: Error | undefined,
    replaceOnRead = false;
  const dispatched = deferred(),
    interrupted = deferred();
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => identity,
      settings: () => ({
        providers: [{ id: "p", model: "m" }],
        activeProviderId: "p",
      }),
      onEvent: () => () => {},
      localLoadConversation: async () => {
        await loadGate;
        if (c && replaceOnRead)
          c = {
            ...c,
            createdAt: 2,
            turns: [{ ...c.turns[0], id: "replacement-turn", createdAt: 2 }],
          };
        return c;
      },
      localCall: async (name: string, input: any) => {
        calls.push(name);
        if (name === "send") {
          dispatched.resolve();
          await sendGate;
          if (sendError) throw sendError;
          c = {
            id: input.newConversationId,
            mode: "cowork",
            title: "Task",
            pinned: false,
            archived: false,
            providerId: "p",
            model: "m",
            turns: [
              {
                id: "original-turn",
                prompt: "task",
                attachments: [],
                items: [],
                status: "inProgress",
                createdAt: 1,
              },
            ],
            createdAt: 1,
            updatedAt: 1,
          };
          return c;
        }
        if (name === "interrupt") {
          assert.equal(input, id);
          interrupted.resolve();
          await interruptGate;
          return;
        }
        throw Error(`Unexpected ${name}`);
      },
    },
    on(n: string, f: any) {
      handlers.set(n, f);
      return this;
    },
    emit() {},
  } as never);
  return {
    calls,
    dispatched,
    interrupted,
    start: () =>
      handlers.get("LocalAgentModeSessions.start")({
        sessionId: key,
        message: "task",
      }),
    stop: () => handlers.get("LocalAgentModeSessions.stop")(key),
    loadGate(p: Promise<void>) {
      loadGate = p;
    },
    sendGate(p: Promise<void>) {
      sendGate = p;
    },
    interruptGate(p: Promise<void>) {
      interruptGate = p;
    },
    replaceOnRead() {
      replaceOnRead = true;
    },
    failSend() {
      sendError = Error("mock send failed");
    },
    reactivate() {
      identity = {};
      c = undefined;
    },
  };
}
test("Cowork stop during reservation/preparation blocks dispatch and allows a later fresh retry", async () => {
  const f = fixture(),
    gate = deferred();
  f.loadGate(gate.promise);
  const start = f.start(),
    rejected = assert.rejects(start, /cancelled before dispatch/);
  await f.stop();
  await f.stop();
  gate.resolve();
  await rejected;
  assert.deepEqual(f.calls, []);
  assert.equal((await f.start()).sessionId, key);
  assert.deepEqual(f.calls, ["send"]);
});
test("already dispatched startup cancellation fails closed without backend ownership CAS", async () => {
 const f=fixture(),gate=deferred();f.sendGate(gate.promise);
 const start=f.start(),failed=assert.rejects(start,/cancellation is not confirmed/);await f.dispatched.promise;
 const stop=f.stop(),again=f.stop(),a=assert.rejects(stop,/cancellation is not confirmed/),b=assert.rejects(again,/cancellation is not confirmed/);
 gate.resolve();await Promise.all([failed,a,b]);assert.deepEqual(f.calls,["send"]);
});

test("startup failure remains an error rather than a fake stopped success", async () => {
  const f = fixture(),
    gate = deferred();
  f.sendGate(gate.promise);
  f.failSend();
  const start = f.start(),
    failed = assert.rejects(start, /mock send failed/);
  await f.dispatched.promise;
  const stop = f.stop(),
    stopFailed = assert.rejects(stop, /mock send failed/);
  gate.resolve();
  await Promise.all([failed, stopFailed]);
  assert.deepEqual(f.calls, ["send"]);
});
test("old startup cancellation never interrupts a newly activated account", async () => {
  const f = fixture(),
    gate = deferred();
  f.sendGate(gate.promise);
  const start = f.start(),
    failed = assert.rejects(start, /account changed/);
  await f.dispatched.promise;
  const stop = f.stop(),
    stopFailed = assert.rejects(stop, /account changed/);
  f.reactivate();
  gate.resolve();
  await Promise.all([failed, stopFailed]);
  assert.deepEqual(f.calls, ["send"]);
});

test("a hung dispatched startup yields an unconfirmed cancellation error, never a fake success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(),
    gate = deferred();
  f.sendGate(gate.promise);
  const start = f.start(),
    failed = assert.rejects(start, /cancellation is not confirmed/);
  await f.dispatched.promise;
  const stop = f.stop(),
    unconfirmed = assert.rejects(stop, /not yet confirmed/);
  t.mock.timers.tick(30_000);
  await unconfirmed;
  assert.deepEqual(f.calls, ["send"]);
  f.replaceOnRead();
  await assert.rejects(f.stop(), /not yet confirmed/);
  gate.resolve();
  await failed;
  assert.deepEqual(
    f.calls,
    ["send"],
    "expired startup must not interrupt a potentially replaced session",
  );
});

test("same-ID replacement before cancellation read is never interrupted", async () => {
  const f = fixture(),
    gate = deferred();
  f.sendGate(gate.promise);
  const start = f.start(),
    failed = assert.rejects(start, /cancellation is not confirmed/);
  await f.dispatched.promise;
  const stop = f.stop(),
    stopFailed = assert.rejects(stop, /cancellation is not confirmed/);
  f.replaceOnRead();
  gate.resolve();
  await Promise.all([failed, stopFailed]);
  assert.deepEqual(f.calls, ["send"]);
});

test("Cowork Send hands the input to the active turn with the original message UUID", async () => {
  const conversation = {
    id: "task", mode: "cowork", title: "Task", model: "m", providerId: "p",
    createdAt: 1, updatedAt: 1, archived: false, pinned: false,
    turns: [{ id: "active", status: "inProgress", prompt: "Original", createdAt: 1, items: [], attachments: [] }],
  } as Conversation;
  const calls: [string, unknown[]][] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let moved = false;
  let fails = false;
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      onEvent: () => () => {},
      localLoadConversation: async () => structuredClone(conversation),
      localCall: async (method: string, ...args: unknown[]) => {
        calls.push([method, args]);
        if (method === "officialCoworkSteer") {
          if (fails) throw Error("Provider acknowledgement lost");
          return moved ? null : { messageId: "engine-input" };
        }
        if (method === "send") return undefined;
        throw Error("Unexpected " + method);
      },
    },
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
  } as never);
  const submit = handlers.get("LocalAgentModeSessions.sendMessage")!;
  assert.deepEqual(await submit("local_task", "Next", [], [], "original-input"), { dispatched: true });
  assert.deepEqual(calls.map(([name]) => name), ["officialCoworkSteer"]);
  assert.deepEqual(calls[0][1].slice(0, 2), ["task", {
    text: "Next", attachmentIds: [], messageId: "original-input",
  }]);
  calls.length = 0;
  fails = true;
  await assert.rejects(async () => submit("local_task", "No duplicate", [], [], "unknown-input"), /acknowledgement lost/);
  assert.deepEqual(calls.map(([name]) => name), ["officialCoworkSteer"]);
  calls.length = 0;
  fails = false;
  moved = true;
  assert.deepEqual(await submit("local_task", "After finish", [], [], "new-turn-input"), { dispatched: true });
  assert.deepEqual(calls.map(([name]) => name), ["officialCoworkSteer", "send"]);
});
