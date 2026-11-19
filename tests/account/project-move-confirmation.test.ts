/** Actual local/CloudStore project metadata acknowledgment. No service/model calls. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { CloudStore } from "../../runner/src/cloud-store";
import { LinkRequestError } from "../../runner/src/control-link";
import { registerConversationManageHandlers } from "../../electron/ipc/conversation-manage-handlers";
import { webErrorCodes } from "../../shared/web-protocol";
function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-confirm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture<S extends Store>(store: S, mode = "chat") {
  const c: any = {
    id: "own",
    mode,
    title: "Own",
    providerId: "inert",
    model: "inert",
    pinned: false,
    archived: false,
    createdAt: 2,
    updatedAt: 2,
    turns: [],
  };
  store.conversations = [c];
  store.projects = [
    {
      id: "project",
      kind: "chat",
      name: "Project",
      description: "",
      instructions: "",
      createdAt: 1,
      cwd: "/synthetic-owned-folder",
    },
  ];
  let active = store,
    generation = 1,
    flushes = 0,
    confirms = 0;
  let closeTerminals: (() => Promise<void>) | undefined;
  const effects: string[] = [],
    handlers = new Map<string, Function>();
  const flush = store.flush.bind(store),
    confirm = store.confirmConversationMetadata.bind(store);
  store.flush = () => {
    flushes++;
    effects.push("flush");
    flush();
  };
  store.confirmConversationMetadata = (...args) => {
    confirms++;
    assert.equal(args[2], true);
    effects.push("confirm");
    return confirm(...args);
  };
  registerConversationManageHandlers({
    context: {
      get store() {
        return active;
      },
      engine: {},
      accountGeneration: () => generation,
      closeTerminals: () => closeTerminals?.(),
      replyFeedback: { deleteConversation() {} },
      allowedFolder: (p: string) => {
        assert.equal(p, "/synthetic-owned-folder");
        effects.push("allowedFolder");
      },
      push: () => effects.push("push"),
    },
    engineOf: () => undefined,
    handle: (n: string, f: Function) => handlers.set(n, f),
  } as any);
  return {
    store,
    c,
    effects,
    get flushes() {
      return flushes;
    },
    get confirms() {
      return confirms;
    },
    run: (patch: any, expected?: unknown) => handlers.get("updateConversation")!("own", expected === undefined ? patch : { ...patch, projectId: { version: 1, target: patch.projectId, expected } }),
    move: (target: string | null) => handlers.get("updateConversation")!("own", {
      projectId: { version: 1, target, expected: { conversationId: c.id, mode: c.mode,
        createdAt: c.createdAt, sourceProjectId: c.projectId ?? null,
        destinationCreatedAt: store.projects.find(p => p.id === target)?.createdAt ?? null } },
    }),
    remove: () => handlers.get("deleteConversation")!("own"),
    beforeDelete: (close: () => Promise<void>) => { closeTerminals = close; },
    retire: () => generation++,
    replaceStore: () => (active = Object.create(store)),
    replaceObject: () => (store.conversations = [{ ...c }]),
  };
}
function cloud(t: any, send: (op: string, body: any) => Promise<any>) {
  const s = new CloudStore({
    root: directory(t),
    userId: 1,
    log() {},
    transport: { request: async (op, _u, body) => send(op, body) },
  });
  t.after(() => s.close());
  return s;
}
test("Chat and Cowork local move/remove preserve folder effects, one flush and confirmation before push", async (t) => {
  for (const mode of ["chat", "cowork"]) {
    const s = new Store(directory(t)),
      f = fixture(s, mode);
    const r = await f.run({ projectId: "project" });
    assert.notEqual(r, f.c);
    assert.deepEqual(f.effects, ["allowedFolder", "flush", "confirm", "push"]);
    assert.equal(f.flushes, 1);
    assert.equal(f.confirms, 1);
    assert.equal(new Store(s.root).conversation("own").projectId, "project");
    f.effects.length = 0;
    await f.run({ projectId: null });
    assert.deepEqual(f.effects, ["flush", "confirm", "push"]);
    assert.equal(new Store(s.root).conversation("own").projectId, undefined);
    assert.equal(f.c.cwd, "/synthetic-owned-folder");
  }
});
test("actual local flush failure retains original memory/folder side effects, reports unknown without push or replay", async (t) => {
  const s = new Store(directory(t)),
    f = fixture(s);
  s.flush();
  f.effects.length = 0;
  const old = s.write.bind(s);
  s.write = (name, v) => {
    if (name === "conversations.json")
      throw Error("PRIVATE synthetic disk failure");
    old(name, v);
  };
  await assert.rejects(
    f.run({ projectId: "project" }),
    /project move could not be confirmed.*already have occurred/,
  );
  assert.equal(f.c.projectId, "project");
  assert.equal(f.c.cwd, "/synthetic-owned-folder");
  assert.equal(new Store(s.root).conversation("own").projectId, undefined);
  assert.deepEqual(f.effects, ["allowedFolder", "flush"]);
  assert.equal(f.confirms, 0);
});
test("queued cloud put holds result/push until exact acknowledgment without second flush or put", async (t) => {
  let release!: () => void,
    entered!: () => void,
    puts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r));
  const f = fixture(
    cloud(t, async (op, body) => {
      if (op === "store.conversations.put") {
        puts++;
        assert.equal(body.doc.conversation.projectId, "project");
        entered();
        await gate;
      }
      return { revision: 1 };
    }),
    "cowork",
  );
  let done = false;
  const p = f.run({ projectId: "project" }).then((r: any) => {
    done = true;
    return r;
  });
  await start;
  assert.equal(done, false);
  assert.equal(f.effects.includes("push"), false);
  release();
  assert.equal((await p).projectId, "project");
  assert.equal(f.flushes, 1);
  assert.equal(f.confirms, 1);
  assert.equal(puts, 1);
  assert.equal(f.effects.at(-1), "push");
});
test("cloud rejection is unknown, performs one attempt and retains changed memory with no publication", async (t) => {
  let fail = true,
    puts = 0;
  const f = fixture(
    cloud(t, async (op) => {
      if (op === "store.conversations.put") {
        puts++;
        if (fail) throw Error("PRIVATE refused");
      }
      return { revision: 1 };
    }),
  );
  await assert.rejects(
    f.run({ projectId: "project" }),
    /project move could not be confirmed/,
  );
  assert.equal(puts, 1);
  assert.equal(f.flushes, 1);
  assert.equal(f.confirms, 1);
  assert.equal(f.c.projectId, "project");
  assert.equal(f.effects.includes("push"), false);
  fail = false;
});
test("activation, Store, object replacement and newer membership while acknowledgment waits cannot publish or replay", async (t) => {
  for (const change of [
    "retire",
    "replaceStore",
    "replaceObject",
    "membership",
  ] as const) {
    let release!: () => void,
      entered!: () => void,
      puts = 0;
    const gate = new Promise<void>((r) => (release = r)),
      start = new Promise<void>((r) => (entered = r));
    const f = fixture(
      cloud(t, async (op) => {
        if (op === "store.conversations.put") {
          puts++;
          entered();
          await gate;
        }
        return { revision: 1 };
      }),
    );
    const p = f.run({ projectId: "project" });
    await start;
    if (change === "membership") f.c.projectId = undefined;
    else f[change]();
    release();
    await assert.rejects(p, /project move could not be confirmed/);
    assert.equal(f.effects.includes("push"), false);
    assert.equal(f.flushes, 1);
    assert.equal(f.confirms, 1);
    assert.equal(puts, 1);
  }
});
test("Code and mixed patches preserve existing path, destination denial precedes all effects", async (t) => {
  for (const [mode, patch] of [
    ["code", { projectId: "project" }],
    ["chat", { projectId: "project", pinned: true }],
  ] as const) {
    const f = fixture(new Store(directory(t)), mode);
    const r = f.run(patch);
    assert.equal(r, f.c);
    assert.equal(f.confirms, 0);
    assert.deepEqual(f.effects, ["allowedFolder", "flush", "push"]);
  }
  const f = fixture(new Store(directory(t)));
  assert.throws(() => f.run({ projectId: "foreign" }), /Unknown project/);
  assert.deepEqual(f.effects, []);
  assert.equal(f.c.projectId, undefined);
});

test("move queued behind existing metadata write waits for the subsequent exact row, not the old ack", async (t) => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r)),
    projects: unknown[] = [];
  const f = fixture(
    cloud(t, async (op, body) => {
      if (op === "store.conversations.put") {
        projects.push(body.doc.conversation.projectId);
        if (projects.length === 1) {
          entered();
          await gate;
        }
      }
      return { revision: projects.length };
    }),
  );
  const prior = f.store.sync("full");
  await start;
  let done = false;
  const move = f.run({ projectId: "project" }).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  release();
  await prior;
  await move;
  assert.deepEqual(projects, [undefined, "project"]);
  assert.equal(f.flushes, 1);
  assert.equal(f.confirms, 1);
  assert.equal(f.effects.at(-1), "push");
});
test("real confirmation timeout stays unknown when the same background write later succeeds, without late push or replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void,
    entered!: () => void,
    puts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r));
  const f = fixture(
    cloud(t, async (op) => {
      if (op === "store.conversations.put") {
        puts++;
        entered();
        await gate;
      }
      return { revision: 1 };
    }),
  );
  const move = f.run({ projectId: "project" });
  const rejected = assert.rejects(move, /project move could not be confirmed/);
  await start;
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(f.effects.includes("push"), false);
  release();
  await f.store.settled();
  assert.equal(puts, 1);
  assert.equal(f.effects.includes("push"), false);
  assert.equal(f.c.projectId, "project");
  assert.equal(f.flushes, 1);
  assert.equal(f.confirms, 1);
  t.mock.timers.reset();
});

// F029 isolated native regression proposals; synthetic data only.
test("duplicate canonical conversation IDs reject before membership/folder/write effects", async (t) => {
  const f = fixture(new Store(directory(t)));
  f.store.conversations.push({ ...f.c, title: "Different identity" });
  await assert.rejects(async () => f.run({ projectId: "project" }));
  assert.deepEqual(f.effects, []);
  assert.equal(f.c.projectId, undefined);
});

test("populated Chat/Cowork history, branches, thread linkage and attachments survive move/reopen/remove/reopen", async (t) => {
  for (const mode of ["chat", "cowork"]) {
    const s = new Store(directory(t)), f = fixture(s, mode);
    const turn = { id: "turn-a", prompt: "Synthetic user text", status: "completed", createdAt: 1,
      attachments: [{ id: "attachment-a", name: "synthetic.txt", path: "/synthetic/attachment-a" }],
      items: [{ id: "item-a", type: "message", text: "Synthetic answer" }] };
    Object.assign(f.c, { threadId: "thread-live", turns: [turn],
      savedBranches: [{ id: "branch-a", threadId: "thread-branch", title: "Earlier branch", turns: [{ ...structuredClone(turn), id: "turn-branch" }] }],
      pinned: true, archived: false, createdAt: 1, updatedAt: 2 });
    const before = structuredClone(f.c);
    const history = (c: any) => { const { projectId, cwd, ...rest } = c; return rest; };
    await f.run({ projectId: "project" });
    assert.deepEqual(history(s.conversation("own")), before);
    assert.deepEqual(history(new Store(s.root).conversation("own")), before);
    await f.run({ projectId: null });
    assert.deepEqual(history(s.conversation("own")), before);
    assert.deepEqual(history(new Store(s.root).conversation("own")), before);
  }
});

for (const change of ["replace", "kind", "duplicate"] as const) test(`destination ${change} during cloud acknowledgment must not publish confirmed membership`, async (t) => {
  let enter!: () => void, release!: () => void;
  const start = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  const f = fixture(cloud(t, async op => { if (op === "store.conversations.put") { enter(); await gate; } return {}; }));
  const move = f.run({ projectId: "project" });
  await start;
  if (change === "replace") f.store.projects = [{ ...f.store.projects[0] }];
  if (change === "kind") (f.store.projects[0] as any).kind = "code";
  if (change === "duplicate") f.store.projects.push({ ...f.store.projects[0] });
  release();
  await assert.rejects(move, /project move could not be confirmed/);
  assert.equal(f.effects.includes("push"), false);
  assert.equal(f.flushes, 1);
  assert.equal(f.c.projectId, "project", "rejection must not imply rollback");
});

test("overlapping project move/removal acknowledges only current membership without replay", async (t) => {
  let enter!: () => void, release!: () => void;
  const start = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  const writes: unknown[] = [];
  const f = fixture(cloud(t, async (op, body) => {
    if (op === "store.conversations.put") { writes.push(body.doc.conversation.projectId); if (writes.length === 1) { enter(); await gate; } }
    return {};
  }));
  const first = f.run({ projectId: "project" });
  const rejected = assert.rejects(first, /project move could not be confirmed/);
  await start;
  const second = f.run({ projectId: null });
  release();
  await rejected;
  assert.equal((await second).projectId, undefined);
  assert.deepEqual(writes, ["project", undefined]);
  assert.equal(f.effects.filter(v => v === "push").length, 1);
  assert.equal(f.flushes, 2);
});

test("ambiguous/non-Chat destinations reject before mutation; legacy kind and unrelated edits stay eligible", async (t) => {
  for (const invalid of ["duplicate", "kind"]) {
    const f = fixture(new Store(directory(t)));
    if (invalid === "duplicate") f.store.projects.push({ ...f.store.projects[0] });
    else (f.store.projects[0] as any).kind = "code";
    await assert.rejects(async () => f.run({ projectId: "project" }));
    assert.deepEqual(f.effects, []);
    assert.equal(f.c.projectId, undefined);
    assert.equal(Object.hasOwn(f.store.projects[0], "visibility"), false);
  }
  let enter!: () => void, release!: () => void;
  const start = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  const f = fixture(cloud(t, async op => { if (op === "store.conversations.put") { enter(); await gate; } return {}; }));
  delete f.store.projects[0].kind;
  const move = f.run({ projectId: "project" });
  await start;
  f.store.projects[0].name = "Renamed project";
  f.store.projects[0].instructions = "Updated instructions";
  release();
  assert.equal((await move).projectId, "project");
  assert.equal(f.store.projects[0].visibility, "private");
  assert.equal(f.effects.filter(v => v === "push").length, 1);
});

test("project identity fence preserves exact visibility migration semantics even on write failure", async (t) => {
  for (const visibility of ["missing", "undefined", "private", "public"] as const)
    for (const fail of [false, true]) {
      const s = new Store(directory(t)), f = fixture(s);
      const p = s.projects[0];
      if (visibility !== "missing") (p as any).visibility = visibility === "undefined" ? undefined : visibility;
      const expected = visibility === "missing" ? "private" : visibility === "undefined" ? undefined : visibility;
      const baseline = new Store(directory(t));
      baseline.projects = [structuredClone(p)];
      if (fail) {
        s.write = () => { throw Error("Synthetic write failure"); };
        baseline.write = () => { throw Error("Synthetic write failure"); };
      }
      try { baseline.flush(); } catch {}
      if (fail) await assert.rejects(f.run({ projectId: "project" }), /could not be confirmed/);
      else await f.run({ projectId: "project" });
      assert.equal(s.projects[0].visibility, expected, visibility);
      assert.equal(Object.hasOwn(s.projects[0], "visibility"), true);
      assert.deepEqual(s.projects[0], baseline.projects[0], visibility + "/" + fail);
      assert.equal(f.effects.includes("push"), !fail);
      if (fail) assert.equal(f.c.projectId, "project", "uncertain does not mean rollback");
    }
});

test("serialized project move guard rejects malformed and stale identity before effects, preserving unguarded callers", async (t) => {
  const expected = { conversationId: "own", mode: "chat", createdAt: 2, sourceProjectId: null, destinationCreatedAt: 1 };
  for (const guard of [null, {}, { ...expected, extra: true }, { ...expected, mode: "code" },
    { ...expected, createdAt: Infinity }, { ...expected, conversationId: "other" },
    { ...expected, createdAt: 3 }, { ...expected, sourceProjectId: "newer" }, { ...expected, destinationCreatedAt: 3 }]) {
    const f = fixture(new Store(directory(t)));
    await assert.rejects(async () => f.run({ projectId: "project" }, guard));
    assert.deepEqual(f.effects, []);
    assert.equal(f.c.projectId, undefined);
  }
  for (const patch of [{ projectId: "project", pinned: true }, { projectId: "project", extra: true }, { pinned: true }]) {
    const f = fixture(new Store(directory(t)));
    await assert.rejects(async () => f.run(patch, expected));
    assert.deepEqual(f.effects, []);
  }
  const code = fixture(new Store(directory(t)), "code");
  await assert.rejects(async () => code.run({ projectId: "project" }, expected));
  assert.deepEqual(code.effects, []);
  const f = fixture(new Store(directory(t)));
  assert.equal((await f.run({ projectId: "project" }, expected)).projectId, "project");
  assert.equal((await f.run({ projectId: null }, { ...expected, sourceProjectId: "project", destinationCreatedAt: null })).projectId, undefined);
});

test("versioned projectId envelope rejects malformed versions and fields before effects", async (t) => {
  const expected = { conversationId: "own", mode: "chat", createdAt: 2, sourceProjectId: null, destinationCreatedAt: 1 };
  for (const projectId of [[], {}, { version: 2, target: "project", expected },
    { version: 1, target: "project", expected, extra: true },
    { version: 1, target: 7, expected }, { version: 1, target: "project" },
    { version: 1, target: "project", expected: { ...expected, unexpected: true } }]) {
    const f = fixture(new Store(directory(t)));
    await assert.rejects(async () => f.run({ projectId }));
    assert.deepEqual(f.effects, []);
    assert.equal(f.c.projectId, undefined);
  }
});

test("guarded local moves commit one history file and publish only after a successful rename", async (t) => {
  const f = fixture(new Store(directory(t)));
  const write = f.store.write.bind(f.store);
  const writes: string[] = [];
  let fail = true;
  f.store.write = (name, value) => {
    writes.push(name);
    assert.equal(f.c.projectId, undefined);
    assert.equal(f.c.cwd, undefined);
    if (fail) throw Error("Synthetic history rename failure");
    write(name, value);
  };
  await assert.rejects(f.move("project"), /project move could not be confirmed/);
  assert.equal(f.c.projectId, undefined);
  assert.equal(f.c.cwd, undefined);
  assert.deepEqual(f.effects, ["allowedFolder"]);
  fail = false;
  assert.equal((await f.move("project")).cwd, "/synthetic-owned-folder");
  assert.deepEqual(writes, ["conversations.json", "conversations.json"]);
  assert.equal(new Store(f.store.root).conversation("own").projectId, "project");
  assert.deepEqual(f.effects, ["allowedFolder", "allowedFolder", "push"]);
});

test("guarded Cowork moves preserve the session folder and require an active private Chat project", async (t) => {
  const f = fixture(new Store(directory(t)), "cowork");
  f.c.cwd = "/session-folder";
  const project = f.store.projects[0];
  project.visibility = "public";
  assert.throws(() => f.move("project"), /project changed/);
  project.visibility = "private";
  project.archivedAt = 3;
  assert.throws(() => f.move("project"), /project changed/);
  delete project.archivedAt;
  assert.equal((await f.move("project")).cwd, "/session-folder");
  assert.equal((await f.move(null)).cwd, "/session-folder");
  assert.equal(new Store(f.store.root).conversation("own").cwd, "/session-folder");
  assert.deepEqual(f.effects, ["push", "push"]);
});

test("guarded move refuses a session whose deletion already started", async (t) => {
  const f = fixture(new Store(directory(t)));
  let finish!: () => void;
  f.beforeDelete(() => new Promise<void>(resolve => finish = resolve));
  const deletion = f.remove();
  try {
    assert.throws(() => f.move("project"), /conversation or project changed/);
    assert.equal(f.c.projectId, undefined);
    assert.deepEqual(f.effects, []);
  } finally {
    finish();
  }
  await deletion;
  assert.throws(() => new Store(f.store.root).conversation("own"), /not found/);
});

const completedTurn = (id: string) => ({ id, prompt: "Synthetic", createdAt: 3,
  status: "completed", attachments: [], items: [] });

test("guarded CloudStore ACK publishes membership while a queued turn write waits", async (t) => {
  let releasePut!: () => void, enterPut!: () => void, releaseTurn!: () => void, enterTurn!: () => void;
  const putGate = new Promise<void>(r => releasePut = r), putStarted = new Promise<void>(r => enterPut = r);
  const turnGate = new Promise<void>(r => releaseTurn = r), turnStarted = new Promise<void>(r => enterTurn = r);
  const ops: string[] = [];
  let moving = false;
  const f = fixture(cloud(t, async (op, body) => {
    if (moving) {
      ops.push(op);
      if (op === "store.conversations.put") {
        assert.equal(body.doc.conversation.projectId, "project");
        assert.equal("turns" in body.doc.conversation, false);
        enterPut();
        await putGate;
      }
      if (op === "store.turns.put") {
        assert.deepEqual(body.turns.map((row: { turnId: string }) => row.turnId), ["during"]);
        enterTurn();
        await turnGate;
      }
    }
    return { revision: 1 };
  }));
  f.c.turns = [completedTurn("before")];
  await f.store.sync();
  moving = true;
  const move = f.move("project");
  await putStarted;
  assert.equal(f.c.projectId, undefined);
  assert.equal(f.c.cwd, undefined);
  assert.throws(() => f.store.reserveProjectDeletion("project"), /move is still in progress/);
  f.c.turns.push(completedTurn("during"));
  const flush = f.store.sync();
  releasePut();
  await turnStarted;
  try {
    const result = await move;
    assert.equal(result.projectId, "project");
    assert.deepEqual(result.turns.map((turn: { id: string }) => turn.id), ["before", "during"]);
    assert.deepEqual(ops, ["store.conversations.put", "store.turns.put"]);
  } finally {
    releaseTurn();
  }
  await flush;
});

test("lost CloudStore ACK is recovered by an exact readback without replaying the move", async (t) => {
  let stored: any;
  const ops: string[] = [];
  let moving = false;
  const f = fixture(cloud(t, async (op, body) => {
    if (moving) ops.push(op);
    if (op === "store.conversations.put") {
      stored = structuredClone(body);
      if (moving) throw Error("Synthetic dropped acknowledgement after commit");
    }
    if (op === "store.conversations.get") return {
      position: stored.position,
      doc: { conversation: Object.fromEntries(Object.entries(stored.doc.conversation).reverse()), schema: 1 },
    };
    return { revision: 1 };
  }));
  await f.store.sync();
  moving = true;
  assert.equal((await f.move("project")).projectId, "project");
  await f.store.sync();
  assert.deepEqual(ops, ["store.conversations.put", "store.conversations.get"]);
  assert.deepEqual(f.effects, ["allowedFolder", "push"]);
});

test("unknown CloudStore move fences metadata and deletes while active turns can still be stored", async (t) => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), start = new Promise<void>(r => entered = r);
  let stored: any;
  const ops: string[] = [];
  let moving = false;
  const f = fixture(cloud(t, async (op, body) => {
    if (moving) ops.push(op);
    if (op === "store.conversations.put") {
      if (moving) {
        entered();
        await gate;
        throw Error("Synthetic dropped request outcome");
      }
      stored = structuredClone(body);
    }
    if (op === "store.conversations.get") return stored;
    if (op === "store.turns.put") assert.equal(body.turns[0].turnId, "during");
    return { revision: 1 };
  }));
  f.store.projects.push({ ...f.store.projects[0], id: "source" });
  f.c.projectId = "source";
  await f.store.sync();
  moving = true;
  const move = assert.rejects(f.move("project"), /project move could not be confirmed/);
  await start;
  f.c.title = "Edited while writing";
  f.c.turns.push(completedTurn("during"));
  const flush = f.store.sync();
  release();
  await move;
  await flush;
  await f.store.sync();
  assert.equal(f.c.projectId, "source");
  assert.equal(f.c.cwd, undefined);
  assert.throws(() => f.move("project"), /outcome is unknown/);
  assert.throws(() => f.run({ projectId: "project", pinned: true }), /outcome is unknown/);
  assert.throws(() => f.store.reserveProjectDeletion("project"), /outcome is unknown/);
  assert.throws(() => f.store.reserveProjectDeletion("source"), /outcome is unknown/);
  await assert.rejects(f.remove(), /outcome is unknown/);
  assert.deepEqual(ops, ["store.conversations.put", "store.conversations.get", "store.turns.put"]);
  assert.deepEqual(f.effects, ["allowedFolder"]);
});

for (const change of ["retire", "replaceObject", "sourceMembership", "destinationVisibility"] as const) {
  test(`guarded CloudStore move cannot publish after ${change} while the write awaits ACK`, async (t) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), start = new Promise<void>(r => entered = r);
    let moving = false, puts = 0;
    const f = fixture(cloud(t, async op => {
      if (op === "store.conversations.put" && moving) {
        puts++;
        entered();
        await gate;
      }
      return { revision: 1 };
    }));
    await f.store.sync();
    moving = true;
    const move = assert.rejects(f.move("project"), /project move could not be confirmed/);
    await start;
    if (change === "sourceMembership") f.c.projectId = "newer";
    else if (change === "destinationVisibility") f.store.projects[0].visibility = "public";
    else f[change]();
    release();
    await move;
    await f.store.sync();
    assert.equal(f.store.conversation("own").projectId, change === "sourceMembership" ? "newer" : undefined);
    assert.equal(f.c.cwd, undefined);
    assert.equal(puts, 1);
    assert.deepEqual(f.effects, ["allowedFolder"]);
  });
}

test("definitive CloudStore rejection allows a fresh move without a read or automatic write", async (t) => {
  let reject = true;
  const ops: string[] = [];
  const f = fixture(cloud(t, async op => {
    ops.push(op);
    if (op === "store.conversations.put" && reject)
      throw new LinkRequestError({ code: webErrorCodes.quotaExceeded, message: "Synthetic quota refusal" });
    return { revision: 1 };
  }));
  await assert.rejects(f.move("project"), /project move could not be confirmed/);
  assert.deepEqual(ops, ["store.conversations.put"]);
  assert.equal(f.c.projectId, undefined);
  reject = false;
  assert.equal((await f.move("project")).projectId, "project");
  assert.deepEqual(ops, ["store.conversations.put", "store.conversations.put"]);
});
