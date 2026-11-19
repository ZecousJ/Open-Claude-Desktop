import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { Conversation } from "../shared/types";
const id = "11111111-1111-4111-8111-111111111111";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const conversations = new Map<string, Conversation>();
  let account = "one",
    activation = 1,
    sends = 0;
  let loadHook: (() => Promise<void>) | undefined;
  let sendHook: (() => Promise<void>) | undefined;
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  registerExperimentalCoworkSessions({
    ctx: {
      onEvent: () => () => {},
      account: () => ({ id: account }),
      sessionIdentity: () => activation,
      settings: () => ({
        providers: [{ id: "p", model: "m" }],
        activeProviderId: "p",
      }),
      localLoadConversation: async (key: string) => {
        await loadHook?.();
        return conversations.get(`${account}:${key}`);
      },
      localCall: async (name: string, input: any) => {
        assert.equal(name, "send");
        sends++;
        await sendHook?.();
        const c: Conversation = {
          id: input.newConversationId,
          mode: "cowork",
          title: "Task",
          pinned: false,
          archived: false,
          providerId: "p",
          model: "m",
          turns: [],
          createdAt: 1,
          updatedAt: 1,
        };
        conversations.set(`${account}:${c.id}`, c);
        return c;
      },
    },
    on: (name: string, handler: (...args: any[]) => Promise<any>) =>
      handlers.set(name, handler),
    emit() {},
  } as never);
  return {
    conversations,
    get sends() {
      return sends;
    },
    loadHook(fn?: typeof loadHook) {
      loadHook = fn;
    },
    sendHook(fn?: typeof sendHook) {
      sendHook = fn;
    },
    switchAccount() {
      account = "two";
      activation++;
    },
    reactivate() {
      activation++;
    },
    start: () =>
      handlers.get("LocalAgentModeSessions.start")!({
        message: "new",
        sessionId: `local_${id}`,
      }),
  };
}

test("Cowork start refuses an existing ID of any mode without invoking send", async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.sends, 1);
  f.conversations.get(`one:${id}`)!.mode = "chat";
  await assert.rejects(f.start(), /already exists/);
  assert.equal(f.sends, 1);
});

test("Cowork concurrent starts reserve the proposed ID before their first await", async () => {
  const f = fixture(),
    gate = deferred();
  f.loadHook(() => gate.promise);
  const first = f.start();
  await assert.rejects(f.start(), /already being started/);
  gate.resolve();
  await first;
  assert.equal(f.sends, 1);
});

test("Cowork start failure releases its lease but cannot overwrite a partially created session", async () => {
  const f = fixture();
  f.sendHook(async () => {
    throw Error("failed before create");
  });
  await assert.rejects(f.start(), /failed before create/);
  f.sendHook();
  await f.start();
  assert.equal(f.sends, 2);
  await assert.rejects(f.start(), /already exists/);
  assert.equal(f.sends, 2);
});

test("an old account or activation finally cannot unlock a new same-ID start", async () => {
  for (const change of ["switchAccount", "reactivate"] as const) {
    const f = fixture(),
      oldGate = deferred(),
      newGate = deferred();
    let reads = 0;
    f.loadHook(() =>
      ++reads === 1
        ? oldGate.promise
        : reads === 2
          ? newGate.promise
          : Promise.resolve(),
    );
    const old = f.start();
    f[change]();
    const next = f.start();
    oldGate.resolve();
    await assert.rejects(old, /account changed/);
    await assert.rejects(f.start(), /already being started/);
    newGate.resolve();
    await next;
    assert.equal(f.sends, 1);
  }
});

test("Cowork rechecks existence after asynchronous start preparation", async () => {
  const f = fixture();
  let checks = 0;
  f.loadHook(async () => {
    if (++checks === 2)
      f.conversations.set(`one:${id}`, {
        id,
        mode: "cowork",
        title: "existing",
        pinned: false,
        archived: false,
        providerId: "p",
        model: "m",
        turns: [],
        createdAt: 1,
        updatedAt: 1,
      });
  });
  await assert.rejects(f.start(), /already exists/);
  assert.equal(f.sends, 0);
});
