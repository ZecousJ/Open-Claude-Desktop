/** F080 recovery: real local adapter, metadata handler and isolated disk store.
 * No application, provider, original UI or model requests are started. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { Conversation } from "../shared/types";
import { assertNewConversationIdAvailable } from "../electron/engine/new-conversation";
import { send } from "../electron/engine/engine-send";

const rawId = "2f3a06f5-a30a-46a0-a914-5021272f6c23";
const pageId = `local_${rawId}`;
const original = () =>
  ({
    id: rawId,
    title: "Review the current implementation and then improve i",
    mode: "code",
    cwd: process.cwd(),
    providerId: "inert",
    model: "inert",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    turns: [
      {
        id: "turn-one",
        prompt:
          "Review the current implementation and then improve its title handling",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  }) as Conversation;

function fixture(t: any, seeded = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f080-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.settings.providers = [
    { id: "inert", model: "inert", models: [] },
  ] as any;
  store.settings.activeProviderId = "inert";
  if (seeded) store.conversations.push(original());
  store.flush();
  const handlers = new Map<string, (...args: any[]) => any>();
  const native = new Map<string, (...args: any[]) => any>();
  const calls: any[][] = [],
    events: any[] = [];
  let generation = 1;
  registerConversationManageHandlers({
    context: {
      store,
      engine: {},
      accountGeneration: () => generation,
      push: (e: any) => events.push(e),
    },
    engineOf: () => undefined,
    handle: (name: string, fn: any) => handlers.set(name, fn),
  } as any);
  let send: (input: any) => Promise<any> = async () => {
    throw Error("No real send is permitted");
  };
  const ctx = {
    account: () => ({ id: "synthetic-owner" }),
    settings: () => store.settings,
    stateDirectory: () => dir,
    sessionIdentity: () => generation,
    localLoadConversation: async (id: string) =>
      structuredClone(store.conversations.find((c) => c.id === id)),
    localListConversations: async () => structuredClone(store.conversations),
    localCall: async (name: string, ...args: any[]) => {
      calls.push([name, ...args]);
      if (name === "snapshot") return { approvals: [] };
      if (name === "send") return send(args[0]);
      const handler = handlers.get(name);
      if (!handler) throw Error(`Unexpected call: ${name}`);
      return handler(...args);
    },
    onEvent: () => () => {},
  };
  registerExperimentalCodeSessions({
    ctx,
    on: (name: string, fn: any) => native.set(name, fn),
    emit: (...args: any[]) => events.push(args),
  } as any);
  return {
    store,
    dir,
    native,
    handlers,
    calls,
    events,
    ctx,
    setSend: (fn: typeof send) => {
      send = fn;
    },
    retire: () => {
      generation++;
    },
  };
}

test("automatic Code titles retain their source, transcript and IDs after a disk reopen", async (t) => {
  const f = fixture(t),
    before = structuredClone(f.store.conversation(rawId));
  assert.equal(
    (await f.native.get("LocalSessions.getSession")!(pageId)).titleSource,
    "auto",
  );
  // Both provisional forms are accepted without comparing six words with 50 characters.
  for (const title of [
    "Review the current implementation and then",
    "Repair Code title persistence",
  ]) {
    await f.native.get("LocalSessions.updateSession")!(pageId, {
      title,
      titleSource: "auto",
    });
    const reopened = new Store(f.dir).conversation(rawId);
    assert.equal(reopened.title, title);
    assert.equal(reopened.titleSetByUser, false);
    assert.equal(reopened.id, before.id);
    assert.deepEqual(reopened.turns, before.turns);
    assert.equal(
      (await f.native.get("LocalSessions.getSession")!(pageId)).titleSource,
      "auto",
    );
  }
});

test("explicit manual titles, including choosing the same text, cannot be replaced by late auto updates", async (t) => {
  const f = fixture(t),
    c = f.store.conversation(rawId);
  await f.native.get("LocalSessions.updateSession")!(pageId, {
    title: c.title,
    titleSource: "user",
  });
  assert.equal(c.titleSetByUser, true);
  await f.native.get("LocalSessions.updateSession")!(pageId, {
    title: "late automatic result",
    titleSource: "auto",
    isStarred: true,
  });
  const reopened = new Store(f.dir).conversation(rawId);
  assert.equal(reopened.title, original().title);
  assert.equal(reopened.titleSetByUser, true);
  assert.equal(reopened.pinned, true);
  assert.equal(
    (await f.native.get("LocalSessions.getSession")!(pageId)).titleSource,
    "user",
  );
});

for (const change of ["none", "account", "session"] as const) {
  test(`F080 queued manual rename while an automatic save is pending: ${change}`, async (t) => {
    const f = fixture(t);
    const update = f.native.get("LocalSessions.updateSession")!;
    const persist = f.ctx.localCall;
    let beginAuto!: () => void;
    let releaseAuto!: () => void;
    const autoStarted = new Promise<void>((resolve) => {
      beginAuto = resolve;
    });
    const autoCanFinish = new Promise<void>((resolve) => {
      releaseAuto = resolve;
    });
    f.ctx.localCall = async (name, ...args) => {
      const result = await persist(name, ...args);
      if (name === "updateConversation" && args[1].titleSource === "auto") {
        beginAuto();
        await autoCanFinish;
      }
      return result;
    };

    const automatic = update(pageId, {
      title: "Generated title",
      titleSource: "auto",
    });
    const settledAutomatic =
      change === "account"
        ? assert.rejects(automatic, /account changed/i)
        : assert.doesNotReject(automatic);
    await autoStarted;
    const manual = update(pageId, { title: "My title", titleSource: "user" });
    const settledManual =
      change === "none"
        ? assert.doesNotReject(manual)
        : assert.rejects(manual, new RegExp(`${change} changed`, "i"));
    try {
      await Promise.race([
        settledManual,
        new Promise<void>((resolve) => setImmediate(resolve)),
      ]);
      if (change === "account") f.retire();
      if (change === "session") {
        f.store.conversations[0] = { ...original(), createdAt: 10 };
        f.store.flush();
      }
    } finally {
      releaseAuto();
      await settledAutomatic;
    }
    await settledManual;

    const saved = new Store(f.dir).conversation(rawId);
    assert.equal(saved.titleSetByUser === true, change === "none");
    assert.equal(
      saved.title,
      change === "none"
        ? "My title"
        : change === "account"
          ? "Generated title"
          : original().title,
    );
  });
}

test("a legacy manual rename without titleSource remains user-owned", async (t) => {
  const f = fixture(t);
  await f.native.get("LocalSessions.updateSession")!(pageId, {
    title: "My manual title",
  });
  await f.native.get("LocalSessions.updateSession")!(pageId, {
    title: "Automatic",
    titleSource: "auto",
  });
  assert.equal(new Store(f.dir).conversation(rawId).title, "My manual title");
});

test("failed local rename does not publish changed title, source, pin or events", async (t) => {
  const f = fixture(t),
    before = structuredClone(f.store.conversation(rawId));
  const write = (f.store as any).write;
  (f.store as any).write = () => {
    throw Error("inert disk failure");
  };
  await assert.rejects(
    f.native.get("LocalSessions.updateSession")!(pageId, {
      title: "Unsaved",
      titleSource: "user",
      isStarred: true,
    }),
    /inert disk failure/,
  );
  (f.store as any).write = write;
  assert.deepEqual(f.store.conversation(rawId), before);
  assert.deepEqual(new Store(f.dir).conversation(rawId), before);
  assert.deepEqual(f.events, []);
});

test("missing sessions accept only the landing page's empty auto-title reset", async (t) => {
  const f = fixture(t, false),
    update = f.native.get("LocalSessions.updateSession")!;
  await update(pageId, { title: "", titleSource: "auto" });
  await assert.rejects(
    update(pageId, { title: "Not persisted", titleSource: "auto" }),
    /not found/,
  );
  await assert.rejects(
    update(pageId, { title: "", titleSource: "auto", isStarred: true }),
    /not found/,
  );
  assert.deepEqual(f.calls, []);
});

test("title source cannot be sent by itself or bypass a manual title through mixed metadata", async (t) => {
  const f = fixture(t);
  assert.throws(() =>
    f.handlers.get("updateConversation")!(rawId, { titleSource: "auto" }),
  );
  assert.throws(() =>
    f.handlers.get("updateConversation")!(rawId, {
      title: "auto",
      titleSource: "auto",
      archived: true,
    }),
  );
  assert.deepEqual(f.store.conversation(rawId), original());
});

test("reused optimistic start IDs are rejected before sending or staging attachments", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.native.get("LocalSessions.start")!({
      sessionId: pageId,
      cwd: process.cwd(),
      message: "retry",
    }),
    /already exists/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.conversations.length, 1);
});

test("concurrent starts cannot dispatch the same optimistic ID twice", async (t) => {
  const f = fixture(t, false);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setSend(async (input) => {
    entered();
    await gate;
    const c = { ...original(), id: input.newConversationId };
    f.store.conversations.push(c);
    return c;
  });
  const info = { sessionId: pageId, cwd: process.cwd(), message: "first" };
  const first = f.native.get("LocalSessions.start")!(info);
  await began;
  const second = f.native.get("LocalSessions.start")!(info);
  const refused = assert.rejects(second, /already.*start|being started/);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, { sessionId: pageId });
  await refused;
  assert.equal(f.calls.filter((call) => call[0] === "send").length, 1);
});

test("failed creation that retained history cannot be replayed under the same ID", async (t) => {
  const f = fixture(t, false);
  f.setSend(async (input) => {
    f.store.conversations.push({ ...original(), id: input.newConversationId });
    f.store.flush();
    throw Error("inert result lost");
  });
  const info = { sessionId: pageId, cwd: process.cwd(), message: "first" };
  await assert.rejects(
    f.native.get("LocalSessions.start")!(info),
    /inert result lost/,
  );
  await assert.rejects(
    f.native.get("LocalSessions.start")!(info),
    /already exists/,
  );
  assert.equal(f.store.conversations.length, 1);
  assert.equal(f.calls.filter((call) => call[0] === "send").length, 1);
});

test("a definitely failed creation releases its ID for an explicit retry", async (t) => {
  const f = fixture(t, false),
    info = { sessionId: pageId, cwd: process.cwd(), message: "first" };
  f.setSend(async () => {
    throw Error("inert pre-creation failure");
  });
  await assert.rejects(
    f.native.get("LocalSessions.start")!(info),
    /inert pre-creation failure/,
  );
  f.setSend(async (input) => {
    const c = { ...original(), id: input.newConversationId };
    f.store.conversations.push(c);
    return c;
  });
  assert.deepEqual(await f.native.get("LocalSessions.start")!(info), {
    sessionId: pageId,
  });
  assert.equal(f.store.conversations.length, 1);
});

test("invalid optimistic identifiers never silently navigate to a different generated ID", async (t) => {
  const f = fixture(t, false);
  for (const sessionId of ["invalid", rawId, "", 42, null])
    await assert.rejects(
      f.native.get("LocalSessions.start")!({
        sessionId,
        cwd: process.cwd(),
        message: "first",
      }),
      /identifier/,
    );
  assert.deepEqual(f.calls, []);
});

test("an optimistic Code identifier cannot collide with a non-Code conversation", async (t) => {
  const f = fixture(t);
  f.store.conversation(rawId).mode = "chat";
  await assert.rejects(
    f.native.get("LocalSessions.start")!({
      sessionId: pageId,
      cwd: process.cwd(),
      message: "first",
    }),
    /already exists/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.conversation(rawId).mode, "chat");
});

test("an empty automatic reset preserves a manual title and never changes ownership", async (t) => {
  const f = fixture(t);
  await f.native.get("LocalSessions.updateSession")!(pageId, {
    title: "Manual",
    titleSource: "user",
  });
  await f.native.get("LocalSessions.updateSession")!(pageId, {
    title: "",
    titleSource: "auto",
  });
  assert.equal(f.store.conversation(rawId).title, "Manual");
  assert.equal(f.store.conversation(rawId).titleSetByUser, true);
});

test("engine ID guard rejects new-ID collisions but preserves existing-session recovery", () => {
  const rows = [original()],
    before = structuredClone(rows);
  assert.throws(
    () => assertNewConversationIdAvailable({ newConversationId: rawId }, rows),
    /already exists/,
  );
  assert.doesNotThrow(() =>
    assertNewConversationIdAvailable(
      { newConversationId: rawId, conversationId: rawId },
      rows,
    ),
  );
  assert.doesNotThrow(() =>
    assertNewConversationIdAvailable({ conversationId: rawId }, rows),
  );
  assert.doesNotThrow(() =>
    assertNewConversationIdAvailable({ newConversationId: "new" }, rows),
  );
  assert.deepEqual(rows, before);
});

test("real engine send refuses a persisted creation ID before preparing or dispatching", async () => {
  const rows = [original()],
    before = structuredClone(rows);
  const engine = {
    store: { conversations: rows },
    assertMcpAvailable() {},
    elsewhere() {},
    assertSendable() {
      throw Error("Preparation must not run");
    },
  };
  await assert.rejects(
    send.call(engine as any, {
      mode: "code",
      newConversationId: rawId,
      text: "retry",
      attachments: [],
      providerId: "inert",
      model: "inert",
    }),
    /already exists/,
  );
  assert.deepEqual(rows, before);
});

test("real engine send rechecks the creation ID after asynchronous preparation", async () => {
  const rows: Conversation[] = [];
  const engine = {
    store: {
      conversations: rows,
      projects: [],
      settings: { providers: [{ id: "inert" }] },
    },
    assertMcpAvailable() {},
    elsewhere() {},
    policy: () => ({ webSearch: true }),
    assertSendable() {},
    assertIdle() {},
    assertExtensions() {},
    environment: { kind: "local" },
    sendCwd: () => process.cwd(),
    dropWebSearch: async () => {
      rows.push(original());
    },
    canQueue: () => false,
    pendingSend: false,
    changed() {
      throw Error("No duplicate may be published");
    },
  };
  await assert.rejects(
    send.call(engine as any, {
      mode: "code",
      newConversationId: rawId,
      cwd: process.cwd(),
      text: "first",
      attachments: [],
      providerId: "inert",
      model: "inert",
    }),
    /already exists/,
  );
  assert.deepEqual(rows, [original()]);
  assert.equal(engine.pendingSend, false);
});
