/** Native registration -> real metadata IPC -> isolated Store. No model/network. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { codeReadSnapshot } from "../shared/code-read-state";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f090-open-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const c: any = {
    id: "one",
    mode: "code",
    cwd: root,
    title: "Preserved",
    providerId: "p",
    model: "m",
    unread: true,
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    turns: [
      {
        id: "old-turn",
        status: "interrupted",
        createdAt: 2,
        prompt: "Original input",
        items: [],
        attachments: [],
        stopReason: "restart",
      },
    ],
  };
  store.conversations.push(c, { ...structuredClone(c), id: "other" });
  store.flush();
  const events: any[] = [],
    calls: any[] = [],
    scheduled: any[] = [];
  const ipc = new Map<string, any>(),
    native = new Map<string, any>();
  let account = "owner",
    identity = {},
    readOnly = false,
    current = true,
    readGate: Promise<void> | undefined,
    beforeCall: (() => void) | undefined;
  let reply: ((value: any) => any) | undefined;
  let referenceReads = false;
  const main: any = {
    store,
    engine: {},
    accountGeneration: () => identity,
    activeAccount: { id: "owner" },
    scheduler: { markConversationRead: (id: string) => scheduled.push(id) },
    push: (event: any) => events.push(event),
  };
  registerConversationManageHandlers({
    context: main,
    engineOf: () => main.engine,
    handle: (name, fn) => ipc.set(name, fn),
  });
  const ctx: any = {
    account: () => ({ id: account }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    get readOnly() {
      return readOnly;
    },
    isCurrent: () => current,
    localLoadConversation: async (id: string) => {
      const actual = store.conversations.find((row) => row.id === id);
      const c = referenceReads ? actual : structuredClone(actual);
      await readGate;
      return c;
    },
    localCall: async (method: string, ...args: any[]) => {
      calls.push([method, ...args]);
      beforeCall?.();
      if (method !== "updateConversation")
        throw Error("Unexpected side effect: " + method);
      const result = await ipc.get(method)(...args);
      return reply ? reply(result) : result;
    },
    onEvent: () => () => {},
    log() {},
  };
  const state = codeSessionState(ctx);
  // A pending saved input must not be recovered by an opened/warm notification.
  state.write({
    version: 1,
    queues: [
      [
        "one",
        [
          {
            uuid: "saved",
            message: "Do not send",
            state: "queued",
            createdAt: 3,
          },
        ],
      ],
    ],
    messageIds: [],
  });
  registerExperimentalCodeSessions({
    ctx,
    on: (name: string, fn: (...args: any[]) => any) => native.set(name, fn),
    emit() {},
  } as never);
  return {
    root,
    store,
    c,
    main,
    calls,
    events,
    scheduled,
    state,
    run: (name = "personOpenedSession", ...ids: unknown[]) =>
      native.get("LocalSessions." + name)(ids.length ? ids[0] : "local_one"),
    referenceReads: () => {
      referenceReads = true;
    },
    gate: (p: Promise<void>) => {
      readGate = p;
    },
    before: (fn: () => void) => {
      beforeCall = fn;
    },
    reply: (fn: (value: any) => any) => {
      reply = fn;
    },
    switch: () => {
      account = "next";
      identity = {};
      main.activeAccount = { id: "next" };
    },
    retire: () => {
      identity = {};
    },
    readOnly: () => {
      readOnly = true;
    },
    notCurrent: () => {
      current = false;
    },
  };
}

test("opening interrupted Code history persists only read state and never sends saved input", async (t) => {
  const h = fixture(t),
    before = structuredClone(h.c),
    savedInput = h.state.read();
  await h.run();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(h.calls, [
    [
      "updateConversation",
      "one",
      { unread: { version: 1, expected: codeReadSnapshot(before) } },
    ],
  ]);
  assert.deepEqual(h.c, { ...before, unread: false, readStateRevision: 1 });
  assert.equal(new Store(h.root).conversation("one").unread, false);
  assert.equal(new Store(h.root).conversation("other").unread, true);
  assert.deepEqual(h.state.read(), savedInput);
  assert.deepEqual(h.scheduled, ["one"]);
  assert.deepEqual(h.events, [{
    type: "code-read-state", conversationId: "one", unread: false, readStateRevision: 1,
  }]);
  await h.run();
  assert.equal(
    h.calls.length,
    2,
    "repeat open confirms an already-read snapshot",
  );
  assert.equal(h.events.length, 1);
  assert.equal(h.scheduled.length, 1);
});

test("opening history preserves a legacy input offer without migration or release", async (t) => {
  const h = fixture(t);
  h.c.codeNewTask = {
    id: "offer",
    text: "Keep this draft",
    attachments: [],
    providerId: "p",
    model: "m",
  };
  const before = structuredClone(h.c.codeNewTask);
  await h.run();
  assert.deepEqual(h.c.codeNewTask, before);
  assert.equal(h.calls.length, 1);
});

for (const status of ["inProgress", "completed", "failed", "interrupted"])
  test(`open preserves ${status} turn and partial output`, async (t) => {
    const h = fixture(t);
    h.c.turns[0].status = status;
    h.c.turns[0].items = [
      { id: "part", type: "assistantMessage", text: "Partial output" },
    ];
    const before = structuredClone(h.c.turns);
    await h.run();
    assert.deepEqual(h.c.turns, before);
  });

for (const mutation of [
  (h: ReturnType<typeof fixture>) => {
    h.c.updatedAt++;
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.turns.push({ ...h.c.turns[0], id: "new-turn", createdAt: 3 });
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.turns[0].status = "completed";
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.threadId = "new-thread";
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.createdAt = 10;
  },
])
  test("delayed open cannot clear unread for changed activity", async (t) => {
    const h = fixture(t),
      gate = deferred();
    h.gate(gate.promise);
    const pending = assert.rejects(h.run(), /changed|snapshot/);
    mutation(h);
    gate.resolve();
    await pending;
    assert.equal(h.c.unread, true);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.scheduled, []);
  });

for (const retire of ["switch", "retire", "readOnly", "notCurrent"] as const)
  test(`${retire} during the read prevents acknowledgment dispatch`, async (t) => {
    const h = fixture(t),
      gate = deferred();
    h.gate(gate.promise);
    const pending = assert.rejects(h.run(), /account changed|unavailable/);
    h[retire]();
    gate.resolve();
    await pending;
    assert.deepEqual(h.calls, []);
    assert.equal(h.c.unread, true);
  });

for (const id of [
  undefined,
  null,
  1,
  "",
  "one",
  "local_",
  "local_" + "a".repeat(501),
  {},
])
  test("invalid native session id is refused without effects", async (t) => {
    const h = fixture(t);
    await assert.rejects(h.run("personOpenedSession", id), /Invalid/);
    assert.deepEqual(h.calls, []);
  });

for (const change of [
  (h: ReturnType<typeof fixture>) => {
    h.c.cloudHosted = true;
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.environment = { kind: "ssh", hostId: "host" };
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.environment = { kind: "space", spaceId: "space" };
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.mode = "chat";
  },
  (h: ReturnType<typeof fixture>) => {
    h.c.sessionAuthors = {
      ownerAccountUuid: "other",
      viewerAccountUuid: "owner",
    };
  },
])
  test("non-local or foreign-owned history cannot be acknowledged locally", async (t) => {
    const h = fixture(t);
    change(h);
    await assert.rejects(h.run(), /not found/);
    assert.deepEqual(h.calls, []);
  });

test("write failure remains failure and leaves unread persisted with no notification", async (t) => {
  const h = fixture(t);
  h.store.write = () => {
    throw Error("disk unavailable");
  };
  await assert.rejects(h.run(), /disk unavailable/);
  assert.equal(h.c.unread, true);
  assert.equal(new Store(h.root).conversation("one").unread, true);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.scheduled, []);
  assert.equal(h.calls.length, 1);
});

for (const reply of [
  () => undefined,
  () => ({}),
  (c: any) => ({ ...c, unread: true }),
  (c: any) => ({ ...c, readStateRevision: 999 }),
  (c: any) => ({ ...c, id: "other" }),
])
  test("unconfirmed native reply is rejected without a fallback write", async (t) => {
    const h = fixture(t);
    h.reply(reply);
    await assert.rejects(h.run(), /not.*confirmed/);
    assert.equal(h.calls.length, 1);
  });

test("warm explicitly refuses unsupported restart and never releases or sends saved input", async (t) => {
  const h = fixture(t),
    state = h.state.read();
  h.c.codeNewTask = {
    id: "offer",
    text: "Keep",
    attachments: [],
    providerId: "p",
    model: "m",
  };
  const before = structuredClone(h.c);
  await assert.rejects(h.run("warmSession"), /Prewarming.*not supported/);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(h.c, before);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.state.read(), state);
});

test("a host returning live source objects confirms using the pre-save unread snapshot", async (t) => {
  const h = fixture(t);
  h.referenceReads();
  await h.run();
  assert.equal(h.c.unread, false);
  assert.equal(h.c.readStateRevision, 1);
  assert.equal(h.events.length, 1);
});

test("repeat native opens cannot bypass a pending or mutated-but-unknown save", async (t) => {
  const h = fixture(t),
    gate = deferred();
  h.store.persistChatMetadata = async (c, patch) => {
    await gate.promise;
    Object.assign(c, patch);
    throw Error("unknown service save");
  };
  const first = assert.rejects(h.run(), /unknown service save/);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(h.run(), /pending or unknown/);
  gate.resolve();
  await first;
  assert.equal(h.c.unread, false);
  await assert.rejects(h.run(), /pending or unknown/);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.scheduled, []);
});
