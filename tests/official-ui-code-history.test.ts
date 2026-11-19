import { codeForkTurns } from "../shared/code-fork";
/** Actual native registration and durable fork reservation; inert backend/temp files only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
const P = "11111111-1111-4111-8111-111111111111",
  R = "22222222-2222-4222-8222-222222222222",
  F = "33333333-3333-4333-8333-333333333333";
function deferred() {
  let resolve!: (v?: any) => void;
  return { promise: new Promise<any>((r) => (resolve = r)), resolve };
}
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-fork-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent: any = {
    id: P,
    createdAt: 1,
    updatedAt: 2,
    threadId: "thread-parent",
    mode: "code",
    cwd: "/inert-owned",
    providerId: "p",
    model: "m",
    turns: [
      {
        id: "turn-one",
        status: "completed",
        prompt: "one",
        createdAt: 1,
        attachments: [],
        items: [{ id: "reply-one", type: "agentMessage", text: "answer" }],
      },
    ],
  };
  const rows = new Map<string, any>([[P, parent]]),
    calls: any[] = [];
  let identity = 1,
    owner = "owner";
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => true,
    localLoadConversation: async (id: string) => {
      const c = rows.get(id);
      return c ? structuredClone(c) : undefined;
    },
    localCall: async (name: string, id: string, options: any) => {
      calls.push([name, id, options]);
      if (name !== "forkConversation")
        throw Error("Unexpected inert operation " + name);
      const source = rows.get(id),
        index = source.turns.findIndex((x: any) => x.id === options.turnId);
      const forked = {
        ...structuredClone(source),
        id: F,
        createdAt: 3,
        threadId: "thread-fork",
        archived: false,
        cwd: options.cwd ?? source.cwd,
        parentSessionId: P,
        forkedFrom: {
          conversationId: P,
          turnId: options.turnId,
          title: "inert",
        },
        turns: codeForkTurns(source.turns, options.turnId, options.before),
      };
      rows.set(F, forked);
      return structuredClone(forked);
    },
    onEvent: () => () => {},
  };
  function register() {
    const h = new Map<string, Function>();
    registerExperimentalCodeSessions({
      ctx,
      on: (n: string, f: any) => h.set(n, f),
      emit() {},
    } as any);
    return h;
  }
  const h = register();
  return {
    root,
    ctx,
    parent,
    rows,
    calls,
    h,
    register,
    rotate: (same = true) => {
      identity++;
      if (!same) owner = "other";
    },
    run: (id = "local_" + R, message?: string, cwd?: string) =>
      h.get("LocalSessions.forkSession")!("local_" + P, id, message, cwd),
  };
}
test("official optimistic requested ID returns real owned fork ID; repeat dispatches only once", async (t) => {
  const f = setup(t);
  assert.deepEqual(await f.run(), { sessionId: "local_" + F });
  assert.deepEqual(await f.run(), { sessionId: "local_" + F });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], ["forkConversation", P, { turnId: "turn-one", conversationId: R }]);
});
test("explicit message boundary excludes the selected user or assistant message", async (t) => {
  for (const message of ["turn-one:user", "turn-one:item:reply-one"]) {
    const f = setup(t);
    await f.run("local_" + R, message);
    const child = f.rows.get(F);
    assert.equal(child.turns.length, message.endsWith(":user") ? 0 : 1);
    if (child.turns.length) assert.deepEqual(child.turns[0].items, []);
  }
  const f = setup(t);
  await assert.rejects(f.run("local_" + R, "missing"), /unavailable or ambiguous/);
  assert.equal(f.calls.length, 0);
});
test("remote/cloud/incognito/inprogress/changed cwd are rejected without fork dispatch", async (t) => {
  for (const patch of [
    { cloudHosted: true },
    { environment: { kind: "ssh" } },
    { incognito: true },
    { mode: "cowork" },
  ]) {
    const f = setup(t);
    Object.assign(f.parent, patch);
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  }
  const f = setup(t);
  await assert.rejects(
    f.run("local_" + R, undefined, "/different"),
    /ENOENT|directory/,
  );
  f.parent.turns[0].status = "inProgress";
  await assert.rejects(f.run(), /finish/);
  assert.equal(f.calls.length, 0);
});
test("concurrent duplicate request dispatches once, pending duplicate is explicit failure", async (t) => {
  const f = setup(t),
    d = deferred(),
    original = f.ctx.localCall;
  f.ctx.localCall = async (...args: any[]) => {
    await d.promise;
    return original(...args);
  };
  const first = f.run();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(f.run(), /pending/);
  d.resolve();
  await first;
  assert.equal(f.calls.length, 1);
});
test("request payload conflict cannot fork another turn with the same ID", async (t) => {
  const f = setup(t);
  f.parent.turns.push({
    ...structuredClone(f.parent.turns[0]),
    id: "turn-two",
    items: [{ id: "reply-two", type: "agentMessage", text: "second" }],
  });
  await f.run("local_" + R, "turn-one:item:reply-one");
  await assert.rejects(
    f.run("local_" + R, "turn-two:item:reply-two"),
    /different source/,
  );
  assert.equal(f.calls.length, 1);
});
test("backend failure/unknown result is never replayed, including reconstructed registration", async (t) => {
  const f = setup(t);
  f.ctx.localCall = async () => {
    f.calls.push("attempt");
    throw Error("inert outcome unknown");
  };
  await assert.rejects(f.run(), /inert outcome unknown/);
  await assert.rejects(f.run(), /not be replayed/);
  const h = f.register();
  await assert.rejects(
    h.get("LocalSessions.forkSession")!("local_" + P, "local_" + R),
    /not be replayed/,
  );
  assert.equal(f.calls.length, 1);
});
test("activation retired before or after reservation performs no backend dispatch", async (t) => {
  for (const step of [1, 2]) {
    const f = setup(t),
      load = f.ctx.localLoadConversation;
    let reads = 0;
    f.ctx.localLoadConversation = async (id: string) => {
      const result = await load(id);
      if (++reads === step) f.rotate();
      return result;
    };
    await assert.rejects(f.run(), /account changed/);
    assert.equal(f.calls.length, 0);
  }
});
test("late successful backend after account switch is not returned or replayed", async (t) => {
  const f = setup(t),
    call = f.ctx.localCall;
  f.ctx.localCall = async (...a: any[]) => {
    const result = await call(...a);
    f.rotate(false);
    return result;
  };
  await assert.rejects(f.run(), /account changed/);
  assert.equal(f.calls.length, 1);
});
test("returned result must be in current account and match real parent/cwd/turn", async (t) => {
  for (const issue of ["not-owned", "cwd", "parent", "turn"]) {
    const f = setup(t),
      call = f.ctx.localCall;
    f.ctx.localCall = async (...a: any[]) => {
      const result = await call(...a);
      if (issue === "not-owned") f.rows.delete(F);
      if (issue === "cwd") result.cwd = "/different";
      if (issue === "parent") result.parentSessionId = R;
      if (issue === "turn") result.turns = [];
      return result;
    };
    await assert.rejects(
      f.run(),
      /confirmed|available in this account|Code session not found/,
    );
    await assert.rejects(f.run(), /not be replayed/);
    assert.equal(f.calls.length, 1);
  }
});
test("parent branch mutation while backend waits produces unknown outcome, not false fork success", async (t) => {
  const f = setup(t),
    call = f.ctx.localCall;
  f.ctx.localCall = async (...a: any[]) => {
    const result = await call(...a);
    f.parent.activeBranchId = "different";
    return result;
  };
  await assert.rejects(f.run(), /parent history changed/);
  assert.equal(f.calls.length, 1);
});
test("deleted successful fork is not recreated", async (t) => {
  const f = setup(t);
  await f.run();
  f.rows.delete(F);
  await assert.rejects(f.run(), /not be recreated|Code session not found/);
  assert.equal(f.calls.length, 1);
});

test("owned reload cannot substitute a child with unrelated fork metadata", async (t) => {
  const f = setup(t),
    load = f.ctx.localLoadConversation;
  f.ctx.localLoadConversation = async (id: string) => {
    const value = await load(id);
    if (id === F && value) value.forkedFrom.turnId = "unrelated";
    return value;
  };
  await assert.rejects(f.run(), /available in this account/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.run(), /not be replayed/);
});

for (const [label, patch] of Object.entries({
  owner: { sessionAuthors: { ownerAccountUuid: "other" } },
  cloudEnvironment: { cloudEnvironmentId: "remote" },
  savedInput: {
    codeNewTask: { id: "saved", text: "never send", attachments: [] },
  },
}))
  test(`F106 ${label} history refuses fork, rewind and Undo before dispatch`, async (t) => {
    const f = setup(t);
    Object.assign(f.parent, patch);
    for (const action of [
      () => f.run(),
      () => f.h.get("LocalSessions.rewindV2")!("local_" + P, "turn-one:user"),
      () => f.h.get("LocalSessions.undoRewind")!("local_" + P),
    ])
      await assert.rejects(action());
    assert.equal(f.calls.length, 0);
  });
test("F106 read-only at entry and after a local read rejects all history writes", async (t) => {
  for (const late of [false, true]) {
    const f = setup(t),
      load = f.ctx.localLoadConversation;
    if (late)
      f.ctx.localLoadConversation = async (id: string) => {
        const c = await load(id);
        f.ctx.readOnly = true;
        return c;
      };
    else f.ctx.readOnly = true;
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  }
});
test("F106 ownership and saved input changes during the read are rechecked", async (t) => {
  for (const patch of [
    { sessionAuthors: { ownerAccountUuid: "other" } },
    { codeNewTask: { id: "late", text: "never send", attachments: [] } },
  ]) {
    const f = setup(t),
      load = f.ctx.localLoadConversation;
    let n = 0;
    f.ctx.localLoadConversation = async (id: string) => {
      if (++n === 2) Object.assign(f.parent, patch);
      return load(id);
    };
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  }
});
test("F106 same parent serializes fork versus rewind and lifecycle management", async (t) => {
  const f = setup(t),
    d = deferred(),
    call = f.ctx.localCall;
  f.ctx.localCall = async (...args: any[]) => {
    await d.promise;
    return call(...args);
  };
  const fork = f.run();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    f.h.get("LocalSessions.rewindV2")!("local_" + P, "turn-one:user"),
    /pending/,
  );
  await assert.rejects(
    f.h.get("LocalSessions.archive")!("local_" + P),
    /in progress/,
  );
  await assert.rejects(
    f.h.get("LocalSessions.sendMessage")!("local_" + P, "never send"),
    /wait for its changes/,
  );
  d.resolve();
  await fork;
  assert.equal(f.calls.length, 1);
});
test("F106 saved queue after registration refuses history without draining or migrating it", async (t) => {
  const { codeSessionState } =
    await import("../electron/official-ui/native/code-session-state");
  const f = setup(t),
    state = codeSessionState(f.ctx);
  const saved: any = {
    version: 1,
    queues: [
      [
        P,
        [
          {
            uuid: "queued",
            message: "never send",
            state: "queued",
            createdAt: 2,
          },
        ],
      ],
    ],
    messageIds: [],
  };
  state.write(saved);
  await assert.rejects(f.run(), /queued Code work/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(state.read().queues, saved.queues);
});
test("native fork retains source items that have no renderer projection", async (t) => {
  const f = setup(t);
  f.parent.turns[0].items.unshift({ id: "unknown", type: "unrecognized-f106" });
  await f.run();
  assert.deepEqual(f.rows.get(F).turns, f.parent.turns);
});

test("archived source forks into an active child", async (t) => {
  const f = setup(t);
  f.parent.archived = true;
  await f.run();
  assert.equal(f.parent.archived, true);
  assert.equal(f.rows.get(F).archived, false);
});

test("fork into an existing directory records its new cwd", async (t) => {
  const f = setup(t);
  await f.run("local_" + R, undefined, f.root);
  assert.equal(f.rows.get(F).cwd, fs.realpathSync(f.root));
  assert.equal(f.parent.cwd, "/inert-owned");
});
for (const patch of [
  { incognito: true },
  { rewind: { variant: "pending" } },
  { codeNewTask: { id: "inherited" } },
  { sessionAuthors: { ownerAccountUuid: "other" } },
  { projectId: "other-project" },
])
  test(
    "F106 result cannot inherit hidden history/input or change ownership: " +
      JSON.stringify(patch),
    async (t) => {
      const f = setup(t),
        call = f.ctx.localCall;
      f.ctx.localCall = async (...args: any[]) =>
        Object.assign(await call(...args), patch);
      await assert.rejects(f.run(), /could not be confirmed/);
      assert.equal(f.calls.length, 1);
      await assert.rejects(f.run(), /not be replayed/);
      assert.equal(f.calls.length, 1);
    },
  );
