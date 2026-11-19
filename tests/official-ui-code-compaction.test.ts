/** Native handler -> real Engine method/events -> isolated Store. No SDK/model call. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { ensure } from "../electron/engine/engine-lifecycle";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { beginCodeSessionLifecycle } from "../electron/conversations/code-lifecycle-guard";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { officialCodeSendStart } from "../electron/engine/code-send-start";
import { interruptExpectedTurn } from "../electron/conversations/interrupt-target";
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
}
function fixture(t: any, initial: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f105-")),
    store = new Store(root);
  store.settings.providers = [
    { id: "inert", model: "inert", models: [] } as any,
  ];
  const c: any = {
    id: "session",
    mode: "code",
    cwd: root,
    title: "Compaction",
    providerId: "inert",
    model: "inert",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    tokenUsage: {
      last: { totalTokens: 900 },
      total: { totalTokens: 9900 },
      modelContextWindow: 1000,
    },
    turns: [
      {
        id: "base",
        prompt: "Original",
        attachments: [],
        items: [
          { id: "answer", type: "agentMessage", text: "Original answer" },
        ],
        status: "completed",
        createdAt: 1,
      },
    ],
    ...initial,
  };
  store.conversations.push(c);
  store.flush();
  const listeners = new Set<(event: any) => void>(),
    events: any[] = [],
    calls: any[] = [],
    wires: any[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  );
  const e = engine as any;
  let generation = 1,
    owner = "owner",
    forward: () => Promise<void> = async () => {};
  e.ensure = async () => {};
  e.windowsSandbox.ensureReady = async () => {};
  e.sandboxSetupFolder = () => root;
  e.ensureThread = async () => {};
  e.threadOptions = () => ({});
  e.assertModel = () => {};
  e.policy = () => ({});
  e.rpc = { connected: true };
  e.forward = async (method: string, args: any) => {
    wires.push([method, args]);
    await forward();
  };
  const handlers = new Map<string, any>();
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => generation,
    isCurrent: () => true,
    stateDirectory: () => root,
    localLoadConversation: async (id: string) =>
      structuredClone(store.conversations.find((row) => row.id === id)),
    localCall: async (name: string, ...args: any[]) => {
      calls.push([name, ...args]);
      if (name === "snapshot") return { approvals: [] };
      if (name === "interrupt") return interruptExpectedTurn({ store, engine,
        accountGeneration: () => generation }, args[0], args[1]);
      if (name !== "compactConversation") throw Error("Unexpected " + name);
      const started = generation;
      return engine.compactConversation(
        args[0],
        () => started === generation,
        args[1],
        args[2]?.[officialCodeSendStart],
      );
    },
    onEvent: (fn: any) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log: () => {},
  };
  const close = registerExperimentalCodeSessions({
    ctx,
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (_a: string, _b: string, value: any) => events.push(value),
  } as any);
  t.after(() => {
    close();
    for (const timer of e.notificationTimer.values()) clearTimeout(timer);
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    c,
    engine,
    e,
    ctx,
    events,
    calls,
    wires,
    handlers,
    forward: (fn: () => Promise<void>) => (forward = fn),
    retire: () => generation++,
    owner: (value: string) => (owner = value),
    run: (
      message = "/compact",
      uuid = "request",
      images: any[] = [],
      attachments: any[] = [],
    ) =>
      handlers.get("LocalSessions.sendMessage")(
        "local_session",
        message,
        images,
        [],
        attachments,
        "later",
        {},
        uuid,
      ),
    notify: (method: string, params: any) =>
      e.notification({ method, params: { threadId: "thread", ...params } }),
    reopen: () => new Store(root).conversation("session"),
  };
}
test("stopping compaction during preparation prevents dispatch and permits another request", async (t) => {
  const f = fixture(t), ready = deferred(), entered = deferred();
  f.e.ensureThread = async () => { entered.resolve(); await ready.promise; };
  const attempt = f.run();
  const cancelled = assert.rejects(attempt, /cancelled before dispatch/);
  await entered.promise;
  await f.handlers.get("LocalSessions.stop")("local_session");
  ready.resolve();
  await cancelled;
  assert.equal(f.wires.length, 0);
  assert.equal(f.c.turns.length, 1);
  await f.run("/compact", "next-request");
  assert.equal(f.wires.length, 1);
});

test("stopping a dispatched compact waits for its native identity and interrupts that turn", async (t) => {
  const f = fixture(t), accepted = deferred(), entered = deferred();
  f.forward(async () => { entered.resolve(); await accepted.promise; });
  f.e.rpc.call = async (method: string, params: any) => {
    f.wires.push([method, params]);
    f.notify("turn/completed", { turn: { id: "native-compact", status: "interrupted" } });
  };
  const attempt = f.run();
  await entered.promise;
  const stopped = f.handlers.get("LocalSessions.stop")("local_session");
  assert.equal(f.wires.length, 1);
  f.notify("turn/started", { turn: { id: "native-compact" } });
  accepted.resolve();
  await Promise.all([attempt, stopped]);
  assert.deepEqual(f.wires[1], ["turn/interrupt", { threadId: "thread", turnId: "native-compact" }]);
  assert.equal(f.c.turns.at(-1).status, "interrupted");
  assert.equal(f.c.turns.at(-1).userStopped, true);
  assert.equal(f.reopen().turns.at(-1)?.status, "interrupted");
});

test("stopping compaction while its identity is being saved prevents dispatch", async (t) => {
  const f = fixture(t), ready = deferred(), entered = deferred();
  const persist = f.store.persistCodeCompaction.bind(f.store);
  f.store.persistCodeCompaction = async (...args) => {
    entered.resolve();
    await ready.promise;
    await persist(...args);
  };
  const attempt = f.run();
  const cancelled = assert.rejects(attempt, /changed before compaction was saved/);
  await entered.promise;
  await f.handlers.get("LocalSessions.stop")("local_session");
  ready.resolve();
  await cancelled;
  assert.equal(f.wires.length, 0);
  assert.equal(f.c.turns.length, 2);
  assert.equal(f.c.turns.at(-1).status, "interrupted");
  assert.equal(f.reopen().turns.at(-1)?.status, "interrupted");
  await f.run("/compact", "next-request");
  assert.equal(f.wires.length, 1);
});

test("successful compaction uses actual notifications, preserves measured context and survives Store reopen", async (t) => {
  const f = fixture(t);
  f.forward(async () => {
    assert.equal(
      f.reopen().turns.at(-1)?.compactionRequestId,
      "request",
      "request must be persisted before dispatch",
    );
    f.notify("turn/started", { turn: { id: "compact-turn" } });
    f.notify("item/completed", {
      turnId: "compact-turn",
      item: { id: "compact-item", type: "contextCompaction" },
    });
    f.notify("thread/tokenUsage/updated", {
      turnId: "compact-turn",
      tokenUsage: {
        last: { totalTokens: 123 },
        total: { totalTokens: 10023 },
        modelContextWindow: 1000,
      },
    });
    f.notify("turn/completed", {
      turn: { id: "compact-turn", status: "completed" },
    });
  });
  await f.run();
  f.store.flush();
  const saved = f.reopen();
  assert.equal(f.wires.length, 1);
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.turns[0].prompt, "Original");
  assert.equal(saved.turns[1].compaction, "manual");
  assert.equal(saved.turns[1].status, "completed");
  assert.equal(saved.tokenUsage?.last.totalTokens, 123);
  const usage = await f.handlers.get("LocalSessions.getContextUsage")(
    "local_session",
  );
  assert.equal(usage.totalTokens, 123);
  assert.equal(usage.percentage, 12);
  const rows = await f.handlers.get("LocalSessions.getTranscript")(
    "local_session",
  );
  assert.ok(rows.length >= 2);
  assert.doesNotMatch(JSON.stringify(rows), /unsupported/i);
  await f.run();
  assert.equal(f.wires.length, 1);
  // A new actual Engine with a reloaded Store must not dispatch the recorded ID.
  const reopened = new Store(f.root),
    second = new Engine(
      reopened,
      "unused",
      () => "",
      () => {},
    );
  let dispatched = 0;
  (second as any).forward = async () => dispatched++;
  await second.compactConversation("session", () => true, "request");
  assert.equal(dispatched, 0);
});
for (const kind of ["images", "files"])
  test(`compaction refuses ${kind} without dropping or uploading input`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      f.run(
        "/compact",
        "r",
        kind === "images" ? [{}] : [],
        kind === "files" ? [{}] : [],
      ),
      /Remove attachments/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.c.turns.length, 1);
  });
for (const initial of [
  { archived: true },
  { worktree: { state: "deleted" } },
  { incognito: true },
  { cloudHosted: true },
  { sessionAuthors: { ownerAccountUuid: "other", viewerAccountUuid: "other" } },
])
  test(
    "compaction refuses unavailable/foreign session " + JSON.stringify(initial),
    async (t) => {
      const f = fixture(t, initial);
      await assert.rejects(f.run());
      assert.equal(f.wires.length, 0);
    },
  );
test("readonly compact request cannot invoke engine", async (t) => {
  const f = fixture(t);
  f.ctx.readOnly = true;
  await assert.rejects(f.run(), /unavailable/);
  assert.equal(f.calls.length, 0);
});
for (const field of ["queue", "legacy"])
  test(`compaction does not migrate or send saved ${field} input`, async (t) => {
    const f = fixture(
      t,
      field === "legacy"
        ? { codeNewTask: { id: "old", text: "never send" } }
        : {},
    );
    if (field === "queue")
      codeSessionState(f.ctx).write({
        version: 1,
        messageIds: [],
        queues: [
          [
            "session",
            [
              {
                uuid: "queued",
                message: "never send",
                state: "queued",
                createdAt: 1,
              },
            ],
          ],
        ],
      });
    await assert.rejects(f.run(), /resolve queued/);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(f.calls, []);
  });
test("concurrent compact and ordinary sends refuse during setup; lifecycle lock releases", async (t) => {
  const f = fixture(t),
    gate = deferred(),
    ready = deferred();
  f.e.ensure = async () => {
    ready.resolve();
    await gate.promise;
  };
  const first = f.run();
  await ready.promise;
  await assert.rejects(f.run("/compact", "other"), /still being submitted/);
  await assert.rejects(
    f.engine.send({ conversationId: f.c.id, text: "not sent" } as any),
    /session change/,
  );
  gate.resolve();
  await first;
  assert.equal(f.wires.length, 1);
  assert.equal(f.e.pendingSend, false);
});
for (const boundary of ["ensure", "sandbox", "thread"])
  test(`account retirement during ${boundary} prevents compaction dispatch`, async (t) => {
    const f = fixture(t),
      retire = async () => f.retire();
    if (boundary === "ensure") f.e.ensure = retire;
    if (boundary === "sandbox") f.e.windowsSandbox.ensureReady = retire;
    if (boundary === "thread") f.e.ensureThread = retire;
    await assert.rejects(f.run(), /account changed/);
    assert.equal(f.wires.length, 0);
    assert.equal(f.c.turns.length, 1);
  });
for (const field of [
  "cwd",
  "model",
  "threadId",
  "archived",
  "cloudHosted",
  "incognito",
  "sessionAuthors",
])
  test(`changed ${field} during setup refuses stale dispatch`, async (t) => {
    const f = fixture(t);
    f.e.ensure = async () =>
      (f.c[field] = field === "archived" ? true : "changed");
    await assert.rejects(f.run(), /session changed/);
    assert.equal(f.wires.length, 0);
    assert.equal(f.e.pendingSend, false);
  });
test("lifecycle-in-progress and fresh identity checks reject direct Engine compaction", async (t) => {
  const f = fixture(t),
    release = beginCodeSessionLifecycle(f.c);
  await assert.rejects(
    f.engine.compactConversation(f.c.id, () => true, "r"),
    /session change/,
  );
  release();
  await assert.rejects(
    f.engine.compactConversation(f.c.id, () => false, "r"),
    /account changed/,
  );
  assert.equal(f.wires.length, 0);
});
test("durable write failure prevents upstream dispatch and preserves old history", async (t) => {
  const f = fixture(t),
    original = f.store.flush;
  f.store.flush = () => {
    throw Error("disk full");
  };
  await assert.rejects(f.run(), /disk full/);
  f.store.flush = original;
  assert.equal(f.wires.length, 0);
  assert.equal(f.c.turns.length, 1);
  assert.equal(f.reopen().turns.length, 1);
  assert.equal(f.e.pendingSend, false);
});
test("unknown upstream outcome blocks new work until late completion settles the original placeholder", async (t) => {
  const f = fixture(t);
  f.forward(async () => {
    throw Error("transport timeout");
  });
  await assert.rejects(f.run(), /transport timeout/);
  const turn = f.c.turns.at(-1);
  assert.equal(turn.status, "inProgress");
  assert.equal(turn.compactionUncertain, true);
  assert.match(turn.error, /may still be running/);
  assert.equal(f.reopen().turns.at(-1)?.compactionRequestId, "request");
  assert.equal(f.reopen().turns.at(-1)?.status, "interrupted");
  assert.equal(f.reopen().turns.at(-1)?.compactionUncertain, undefined);
  assert.match(f.reopen().turns.at(-1)?.error ?? "", /was interrupted/);
  await assert.rejects(f.run(), /finish/);
  await assert.rejects(f.run("/compact", "other"), /finish/);
  await assert.rejects(
    f.engine.send({ conversationId: f.c.id, text: "not sent" } as any),
  );
  assert.equal(f.wires.length, 1);
  await assert.rejects(f.run("different", "request"), /compaction request/);
  f.notify("turn/started", { turn: { id: "late-compact" } });
  assert.equal(turn.id, "late-compact");
  assert.equal(turn.compactionUncertain, undefined);
  assert.equal(turn.error, undefined);
  f.notify("turn/completed", {
    turn: { id: "late-compact", status: "completed" },
  });
  assert.equal(turn.status, "completed");
  await f.run();
  assert.equal(f.wires.length, 1);
  f.forward(async () => {});
  await f.run("/compact", "new");
  assert.equal(f.wires.length, 2);
});
test("uncertain compaction can settle with terminal notification without started", async (t) => {
  const f = fixture(t);
  f.forward(async () => {
    throw Error("transport timeout");
  });
  await assert.rejects(f.run());
  f.notify("turn/completed", {
    turn: {
      id: "settled",
      status: "failed",
      error: { message: "upstream failed" },
    },
  });
  assert.equal(f.c.turns.at(-1).status, "failed");
  assert.equal(f.c.turns.at(-1).compactionUncertain, undefined);
  assert.doesNotMatch(f.c.turns.at(-1).error, /may still/);
});
test("saved branch compaction IDs cannot be replayed on another active branch", async (t) => {
  const f = fixture(t, {
    savedBranches: [{ turns: [{ compactionRequestId: "request" }] }],
  });
  await f.run();
  assert.equal(f.wires.length, 0);
});
test("exact production composer handler captures account identity and validates request ID", async () => {
  const text = fs.readFileSync(
      new URL("../electron/ipc/composer.ts", import.meta.url),
      "utf8",
    ),
    start = text.indexOf('  handle("compactConversation",'),
    end = text.indexOf('  handle("rewindConversation",', start);
  assert.ok(start > 0 && end > start);
  const calls: any[] = [],
    handlers = new Map<string, any>(),
    ctx: any = {
      accountActivationIdentity: 1,
      accountRetiring: false,
      activeAccount: { id: "owner" },
      store: {},
      engine: { compactConversation: (...args: any[]) => calls.push(args) },
    };
  vm.runInNewContext(ts.transpile(text.slice(start, end)), {
    ctx,
    id: z.string().min(1).max(500),
    handle: (name: string, fn: any) => handlers.set(name, fn),
    officialCodeSendStart,
  });
  const run = handlers.get("compactConversation");
  run("session", "request");
  assert.equal(calls[0][2], "request");
  assert.equal(calls[0][1](), true);
  ctx.accountActivationIdentity = 2;
  assert.equal(calls[0][1](), false);
  ctx.accountRetiring = true;
  assert.throws(() => run("session", "new"), /account changed/);
  ctx.accountRetiring = false;
  assert.throws(() => run("session", {}));
  assert.equal(calls.length, 1);
});

for (const kind of ["provider", "runtime", "stopped"])
  test(`actual ensure supports ${kind} setup without self-blocking`, async (t) => {
    const f = fixture(t);
    f.e.ensure = ensure;
    f.e.assertMcpAvailable = () => {};
    f.e.providerId = kind === "provider" ? "other" : "inert";
    f.e.state = { state: kind === "stopped" ? "stopped" : "ready" };
    f.e.startedMcp = "old";
    f.e.runtimeKey = () => (kind === "runtime" ? "new" : "old");
    f.e.intentionalStop = kind === "stopped";
    let starts = 0;
    f.e.start = async (_provider: any, current: () => boolean) => {
      assert.equal(current(), true);
      starts++;
      assert.equal(f.e.pendingSend, false);
      f.e.intentionalStop = false;
    };
    await f.run();
    assert.equal(starts, 1);
    assert.equal(f.wires.length, 1);
  });
test("actual ensure passes retirement guard into startup before external setup continues", async (t) => {
  const f = fixture(t);
  f.e.ensure = ensure;
  f.e.assertMcpAvailable = () => {};
  f.e.state = { state: "stopped" };
  f.e.rpc = undefined;
  let afterGuard = 0;
  f.e.start = async (_provider: any, current: () => boolean) => {
    assert.equal(current(), true);
    f.retire();
    current();
    afterGuard++;
  };
  await assert.rejects(f.run(), /account|startup changed/);
  assert.equal(afterGuard, 0);
  assert.equal(f.wires.length, 0);
});
test("stop during ensureThread prevents dispatch even while RPC object still exists", async (t) => {
  const f = fixture(t);
  f.e.ensureThread = async () => {
    f.e.intentionalStop = true;
  };
  await assert.rejects(f.run(), /connection changed/);
  assert.equal(f.wires.length, 0);
  assert.equal(f.c.turns.length, 1);
});
test("arguments to /compact are explicitly refused rather than sent as a model prompt", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run("/compact keep files"), /without arguments/);
  assert.deepEqual(f.calls, []);
});

test("actual Engine child activity notifications survive native read and Store reopen", async (t) => {
  const f = fixture(t);
  f.c.turns[0].status = "inProgress";
  f.e.routes.set("thread", f.c.id);
  f.notify("item/started", {
    turnId: "base",
    item: {
      id: "child-call",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "running" } },
      prompt: "Inspect child activity",
    },
  });
  let rows = await f.handlers.get("LocalSessions.getTranscript")(
    "local_session",
  );
  let row = rows.find((v: any) => v.uuid === "base:agent:child-call:child:start");
  assert.ok(row);
  assert.equal(row.task_id, "child");
  assert.equal(row.subtype, "task_started");
  assert.equal(row.task_type, "local_agent");
  f.notify("item/completed", {
    turnId: "base",
    item: {
      id: "child-call",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "interrupted" } },
    },
  });
  f.notify("turn/completed", { turn: { id: "base", status: "completed" } });
  f.store.flush();
  rows = await f.handlers.get("LocalSessions.getTranscript")("local_session");
  row = rows.find((v: any) => v.uuid === "base:agent:child-call:child:done");
  assert.equal(row.status, "stopped");
  assert.match(JSON.stringify(rows), /Inspect child activity/);
  assert.equal(
    f.reopen().turns[0].items.at(-1)?.agentsStates.child.status,
    "interrupted",
  );
  assert.equal(f.wires.length, 0);
});
