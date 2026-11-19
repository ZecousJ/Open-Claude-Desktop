import { execFileSync } from "node:child_process";
/** Actual native registration -> actual IPC -> isolated Store. No user data or model. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { CloudStore } from "../runner/src/cloud-store";
import { Engine } from "../electron/engine/engine";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { registerConversationHandlers } from "../electron/ipc/conversations";
import { registerOfficialGitHandlers } from "../electron/ipc/official-git";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { registerGit } from "../electron/official-ui/native/git";
import { createSessionWorktree, ownsLocalCodeWorktreePath } from "../electron/git/code-worktree";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { assertCodeSessionSendAvailable } from "../electron/conversations/code-lifecycle-guard";
import { openPolicy } from "../shared/client-policy";
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
}
function fixture(t: any, initial: Record<string, any> = {}, queue = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f096-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const c: any = {
    id: "one",
    mode: "code",
    cwd: root,
    title: "Original",
    providerId: "inert",
    model: "inert",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    turns: [],
    ...initial,
  };
  store.conversations.push(c, {
    ...structuredClone(c),
    id: "control",
    title: "Control",
  });
  store.flush();
  const native = new Map<string, any>(),
    ipc = new Map<string, any>(),
    events: any[] = [],
    calls: any[] = [],
    effects: string[] = [],
    listeners = new Set<(event: any) => void>();
  let generation = 1,
    reads = 0;
  const main: any = {
    store,
    engine: {},
    activeAccount: { id: "owner" },
    accountGeneration: () => generation,
    closeTerminals: async () => {
      effects.push("close");
    },
    replyFeedback: { deleteConversation: () => effects.push("feedback") },
    push: (event: any) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  };
  registerConversationManageHandlers({
    context: main,
    engineOf: () => main.engine,
    handle: (name, fn) => ipc.set(name, fn),
  });
  const ctx: any = {
    account: () => ({ id: main.activeAccount.id }),
    sessionIdentity: () => generation,
    isCurrent: () => true,
    stateDirectory: () => root,
    settings: () => store.settings,
    localListConversations: async () => structuredClone(store.conversations),
    localLoadConversation: async (id: string) => {
      reads++;
      return structuredClone(store.conversations.find((c) => c.id === id));
    },
    localCall: async (name: string, ...args: any[]) => {
      calls.push([name, ...args]);
      if (name === "snapshot") return { approvals: [] };
      if (!ipc.has(name)) throw Error("Unexpected call " + name);
      return ipc.get(name)(...args);
    },
    onEvent: (fn: any) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log: () => effects.push("log"),
  };
  const state = codeSessionState(ctx);
  if (queue)
    state.write({
      version: 1,
      queues: [
        [
          c.id,
          [
            {
              uuid: "saved",
              message: "Never send me from a menu",
              state: "queued",
              createdAt: 2,
            },
          ],
        ],
      ],
      messageIds: [],
    });
  const stop = registerExperimentalCodeSessions({
    ctx,
    on: (name: string, fn: any) => native.set(name, fn),
    emit: (_a: string, _b: string, event: any) => events.push(event),
  } as any);
  t.after(stop);
  return {
    root,
    store,
    c,
    main,
    ctx,
    native,
    ipc,
    events,
    calls,
    effects,
    state,
    reads: () => reads,
    retire: () => generation++,
    run: (name: string, ...args: any[]) =>
      native.get("LocalSessions." + name)("local_one", ...args),
    reopen: () => new Store(root),
  };
}
for (const options of [
  undefined,
  {},
  { discardChangesIn: [] },
  { discardChangesIn: undefined },
])
  test(
    "clean delete options persist removal and emit exactly one deleted: " +
      JSON.stringify(options),
    async (t) => {
      const f = fixture(t);
      await f.run("delete", options);
      assert.equal(
        f.store.conversations.some((c) => c.id === "one"),
        false,
      );
      assert.equal(
        f.reopen().conversations.some((c) => c.id === "one"),
        false,
      );
      assert.equal(f.events.filter((e) => e.type === "deleted").length, 1);
      assert.equal(f.events.filter((e) => e.type === "resync").length, 1);
      assert.equal(
        (await f.native.get("LocalSessions.getSessionList")()).sessions.length,
        1,
      );
      assert.equal(f.reopen().conversation("control").title, "Control");
      assert.deepEqual(f.effects, ["close", "feedback"]);
    },
  );
for (const kind of ["archive", "delete"])
  for (const options of [
    null,
    false,
    0,
    "",
    [],
    { discardChangesIn: [1] },
    { discardChangesIn: "" },
    { unknown: false },
  ])
    test(`${kind} rejects malformed/unsupported options before any read: ${JSON.stringify(options)}`, async (t) => {
      const f = fixture(t, {}, true),
        before = JSON.stringify(f.state.read());
      await assert.rejects(f.run(kind, options), /not supported/);
      assert.equal(f.reads(), 0);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.effects, []);
      assert.equal(JSON.stringify(f.state.read()), before);
    });
test("rename, pin, archive, restore preserve title/history and exact persisted menu state", async (t) => {
  const f = fixture(t, { keepAwake: true });
  await f.run("updateSession", { title: "  Renamed  " });
  await f.run("updateSession", { isStarred: true });
  assert.equal(f.reopen().conversation("one").title, "Renamed");
  assert.equal(f.reopen().conversation("one").pinned, true);
  await f.run("archive", {
    cleanupWorktree: true,
    forceWorktreeCleanup: false,
    discardChangesIn: [],
  });
  assert.equal(f.reopen().conversation("one").archived, true);
  assert.equal(f.c.keepAwake, undefined);
  assert.equal(
    (await f.native.get("LocalSessions.getSessionList")()).sessions.find(
      (c: any) => c.sessionId === "local_one",
    ).isArchived,
    true,
  );
  await f.run("unarchive");
  await f.run("updateSession", { isStarred: false });
  assert.equal(f.reopen().conversation("one").archived, false);
  assert.equal(f.reopen().conversation("one").pinned, false);
  assert.equal(f.events.filter((e) => e.type === "archived").length, 1);
  assert.equal(f.events.filter((e) => e.type === "unarchived").length, 1);
  assert.deepEqual(f.c.turns, []);
  assert.equal(
    f.calls.some((c) => c[0] === "send"),
    false,
  );
});
for (const kind of ["archive", "delete"])
  test(`${kind} disk failure preserves memory and disk, publishes no success`, async (t) => {
    const f = fixture(t, { keepAwake: true }),
      before = JSON.stringify(f.c),
      write = f.store.write.bind(f.store);
    f.store.write = (name, value) => {
      if (name === "conversations.json") throw Error("disk full");
      return write(name, value);
    };
    await assert.rejects(f.run(kind), /disk full/);
    assert.equal(JSON.stringify(f.c), before);
    assert.equal(f.reopen().conversation("one").archived, false);
    assert.equal(
      f.events.some((e) => ["archived", "deleted", "resync"].includes(e.type)),
      false,
    );
  });
for (const kind of ["archive", "delete", "unarchive"])
  test(`${kind} rejects running turns before terminal/store effects`, async (t) => {
    const f = fixture(t, {
      turns: [{ id: "run", status: "inProgress", items: [], createdAt: 2 }],
    });
    await assert.rejects(f.run(kind), /running or saved/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.effects, []);
  });
for (const kind of ["archive", "delete"])
  test(`${kind} rejects saved input without recovery or loss`, async (t) => {
    const f = fixture(t, {}, true),
      before = JSON.stringify(f.state.read());
    await assert.rejects(f.run(kind), /running or saved/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(JSON.stringify(f.state.read()), before);
    assert.deepEqual(f.calls, []);
  });
test("list, rename, pin and restore do not dispatch or rewrite recovered queue", async (t) => {
  const f = fixture(t, { archived: true }, true),
    before = JSON.stringify(f.state.read());
  await f.native.get("LocalSessions.getSessionList")();
  await f.run("updateSession", { title: "Renamed" });
  await f.run("updateSession", { isStarred: true });
  await f.run("unarchive");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(JSON.stringify(f.state.read()), before);
  assert.equal(
    f.calls.some((c) =>
      [
        "send",
        "officialReleaseCodeNewTask",
        "officialRestoreCodeAttachments",
      ].includes(c[0]),
    ),
    false,
  );
});
test("menu metadata and list never migrate a legacy next-task offer", async (t) => {
  const offer = {
      id: "offer",
      text: "Saved",
      attachments: [],
      providerId: "p",
      model: "m",
    },
    f = fixture(t, { codeNewTask: offer });
  await f.native.get("LocalSessions.getSessionList")();
  await f.run("updateSession", { title: "Rename" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(f.c.codeNewTask, offer);
  assert.equal(
    f.calls.some((c) => c[0] === "officialReleaseCodeNewTask"),
    false,
  );
});
for (const kind of ["archive", "delete"])
  test(`${kind} waits terminal closure, blocks a second operation and real Engine send`, async (t) => {
    const f = fixture(t),
      gate = deferred(),
      entered = deferred();
    f.main.closeTerminals = async () => {
      entered.resolve();
      await gate.promise;
    };
    const pending = f.run(kind);
    await entered.promise;
    await assert.rejects(f.run(kind), /already in progress/);
    const engine = new Engine(
      f.store,
      "unused",
      () => "",
      () => {},
    );
    await assert.rejects(
      engine.send({
        conversationId: "one",
        mode: "code",
        text: "Do not send",
        attachments: [],
        providerId: "inert",
        model: "inert",
      }),
      /session change/,
    );
    gate.resolve();
    await pending;
  });
for (const kind of ["archive", "delete"])
  for (const phase of ["retired", "new turn"])
    test(`${kind} rechecks ${phase} after terminal await`, async (t) => {
      const f = fixture(t),
        gate = deferred(),
        entered = deferred();
      f.main.closeTerminals = async () => {
        entered.resolve();
        await gate.promise;
      };
      const pending = f.run(kind);
      await entered.promise;
      if (phase === "retired") f.retire();
      else
        f.c.turns.push({
          id: "new",
          status: "inProgress",
          items: [],
          createdAt: 3,
        });
      gate.resolve();
      await assert.rejects(pending, /changed|stale/);
      assert.equal(f.store.conversations.includes(f.c), true);
      assert.equal(f.reopen().conversation("one").archived, false);
      assert.equal(
        f.events.some((e) =>
          ["archived", "deleted", "resync"].includes(e.type),
        ),
        false,
      );
    });
test("delete rechecks the signed delivery before removing the session", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  const entered = deferred();
  f.main.closeTerminals = async () => {
    entered.resolve();
    await gate.promise;
  };
  let deliveryCurrent = true;
  const pending = f.ctx.localCall("deleteConversation", f.c.id, () => deliveryCurrent);
  await entered.promise;
  deliveryCurrent = false;
  gate.resolve();
  await assert.rejects(pending, /changed|stale/);
  assert.equal(f.store.conversation(f.c.id), f.c);
  assert.equal(f.reopen().conversation(f.c.id).title, "Original");
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.effects, []);
  await f.ctx.localCall("deleteConversation", f.c.id, () => true);
  assert.deepEqual(f.reopen().conversations.map(({ id }) => id), ["control"]);
});
test("delete rechecks running state after upstream archive await", async (t) => {
  const f = fixture(t, { threadId: "inert-thread" }),
    gate = deferred(),
    entered = deferred();
  let rpcCalls = 0;
  f.main.engine.rpc = {
    call: async () => {
      rpcCalls++;
      entered.resolve();
      await gate.promise;
    },
  };
  const pending = f.run("delete");
  await entered.promise;
  f.c.turns.push({ id: "new", status: "inProgress", items: [], createdAt: 3 });
  gate.resolve();
  await assert.rejects(pending, /changed|stale/);
  assert.equal(rpcCalls, 1);
  assert.equal(f.store.conversations.includes(f.c), true);
  assert.ok(f.reopen().conversation("one"));
});
for (const field of ["readOnly", "owner", "cloud", "environment"])
  test(`management refuses ${field} session boundary`, async (t) => {
    const f = fixture(t);
    if (field === "readOnly") f.ctx.readOnly = true;
    if (field === "owner")
      f.c.sessionAuthors = {
        ownerAccountUuid: "other",
        viewerAccountUuid: "owner",
      };
    if (field === "cloud") f.c.cloudEnvironmentId = "remote";
    if (field === "environment")
      f.c.environment = { kind: "ssh", hostId: "other" };
    for (const kind of ["archive", "delete", "unarchive", "updateSession"])
      await assert.rejects(
        f.run(kind, kind === "updateSession" ? { title: "Denied" } : undefined),
        /unavailable|not found/,
      );
    assert.deepEqual(f.calls, []);
  });
test("a saved SSH Code session keeps its remote target when restored and archives its SDK thread when deleted", async (t) => {
  const f = fixture(t, { environment: { kind: "ssh", hostId: "saved" }, threadId: "remote-thread" });
  const target = { kind: "ssh", sshHost: "fixture@127.0.0.1", remoteCwd: f.root };
  f.main.services = { ssh: { allowed: () => true, hosts: new Map([["saved", {}]]) } };
  f.ctx.sshCodeEnvironment = () => ({ remoteTarget: target });
  const archived: string[] = [];
  f.main.engine.rpc = {
    call: async (method: string, { threadId }: { threadId: string }) => {
      assert.equal(method, "thread/archive");
      archived.push(threadId);
    },
  };
  await f.run("updateSession", { title: "Renamed SSH", isStarred: true });
  await f.run("archive", { cleanupWorktree: true, forceWorktreeCleanup: false, discardChangesIn: [] });
  assert.equal(f.reopen().conversation("one").archived, true);
  await f.run("unarchive");
  const restored = f.reopen().conversation("one");
  assert.equal(restored.archived, false);
  assert.equal(restored.title, "Renamed SSH");
  assert.equal(restored.pinned, true);
  assert.deepEqual(f.events.find((event) => event.type === "unarchived")?.session.remoteTarget, target);
  await f.run("delete", { discardChangesIn: [] });
  assert.deepEqual(archived, ["remote-thread"]);
  assert.ok(!f.reopen().conversations.some((row) => row.id === "one"));
});
for (const shared of [false, true])
  test(`deleting Code ${shared ? "preserves a scratch used by another session" : "removes its unshared scratch folder"}`, async (t) => {
    const f = fixture(t);
    f.main.engine.defaultWorkspace = path.join(f.root, "workspace");
    const scratch = path.join(f.main.engine.defaultWorkspace, "sessions", "12345678-1234-4123-8123-123456789012");
    const nested = path.join(scratch, "subfolder");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "note.txt"), "scratch fixture");
    f.c.cwd = nested;
    if (shared) f.store.conversation("control").cwd = scratch;
    await f.run("delete", { discardChangesIn: [] });
    assert.equal(fs.existsSync(scratch), shared);
    assert.ok(!f.reopen().conversations.some((row) => row.id === "one"));
  });
test("durable deletion still emits deleted if adapter receipt cleanup fails", async (t) => {
  const f = fixture(t);
  await f.native.get("LocalSessions.getSessionList")();
  const directory = path.join(f.root, "official-ui");
  fs.writeFileSync(directory, "block receipt folder");
  await f.run("delete");
  assert.equal(
    f.reopen().conversations.some((c) => c.id === "one"),
    false,
  );
  assert.equal(f.events.filter((e) => e.type === "deleted").length, 1);
  assert.ok(f.effects.includes("log"));
});
test("archived and unrestored workspace cannot start an actual Engine send", async (t) => {
  for (const patch of [
    { archived: true },
    {
      worktree: {
        state: "deleted",
        path: "/not-used",
        repository: "/not-used",
        branch: "fixture",
      },
    },
  ]) {
    const f = fixture(t, patch);
    const engine = new Engine(
      f.store,
      "unused",
      () => "",
      () => {},
    );
    await assert.rejects(
      engine.send({
        conversationId: "one",
        mode: "code",
        text: "Never send",
        attachments: [],
        providerId: "inert",
        model: "inert",
      }),
      /Restore/,
    );
    assert.throws(() => assertCodeSessionSendAvailable(f.c), /Restore/);
  }
});
test("CloudStore refuses local lifecycle persistence rather than faking service confirmation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f096-cloud-"));
  const store = new CloudStore({
    root,
    userId: 1,
    log: () => {},
    transport: {
      request: async () => {
        throw Error("Unexpected service call");
      },
    },
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => store.assertLocalCodeLifecycleAvailable(), /cloud store/);
});

for (const dirty of [false, true])
  test(`isolated real Git worktree archive/restore preserves branch and ${dirty ? "dirty" : "clean"} files`, async (t) => {
    const f = fixture(t),
      repo = path.join(f.root, "repository"),
      workspace = path.join(f.root, "workspace");
    fs.mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "--initial-branch=main"]);
    fs.writeFileSync(path.join(repo, "note.txt"), "original\n");
    git(["add", "note.txt"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "isolated fixture",
    ]);
    git(["worktree", "add", "-b", "session", workspace]);
    if (dirty)
      fs.writeFileSync(
        path.join(workspace, "note.txt"),
        "saved user changes\n",
      );
    f.c.cwd = workspace;
    f.c.worktree = {
      repository: repo,
      path: workspace,
      origin: repo,
      branch: "session",
      baseBranch: "main",
    };
    f.store.flush();
    await f.run("archive");
    assert.equal(f.reopen().conversation("one").archived, true);
    assert.equal(fs.existsSync(workspace), dirty);
    assert.equal(f.c.worktree.state, dirty ? "kept" : "deleted");
    assert.ok(git(["branch", "--list", "session"]).includes("session"));
    await f.run("unarchive");
    assert.equal(f.reopen().conversation("one").archived, false);
    assert.equal(f.c.worktree.state, undefined);
    assert.equal(
      fs.readFileSync(path.join(workspace, "note.txt"), "utf8"),
      dirty ? "saved user changes\n" : "original\n",
    );
  });
test("failed actual workspace restore remains archived and retryable, with sends blocked", async (t) => {
  const f = fixture(t, { archived: true });
  f.c.worktree = {
    repository: f.root,
    path: path.join(f.root, "absent-workspace"),
    origin: f.root,
    branch: "absent",
    baseBranch: "main",
    state: "deleted",
  };
  f.c.cwd = f.c.worktree.path;
  f.store.flush();
  await assert.rejects(f.run("unarchive"));
  assert.equal(f.c.archived, true);
  assert.equal(f.reopen().conversation("one").archived, true);
  assert.equal(
    f.events.some((e) => e.type === "unarchived"),
    false,
  );
  assert.throws(() => assertCodeSessionSendAvailable(f.c), /Restore/);
});

test("unavailable persistence refuses lifecycle before any terminal or upstream effect", async (t) => {
  const f = fixture(t);
  f.store.assertLocalCodeLifecycleAvailable = () => {
    throw Error("unavailable store");
  };
  for (const kind of ["archive", "unarchive", "delete"])
    await assert.rejects(f.run(kind), /unavailable store/);
  assert.deepEqual(f.effects, []);
  assert.equal(f.c.archived, false);
  assert.ok(f.reopen().conversation("one"));
});

async function dirtyWorktree(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  const repo = path.join(f.root, "repository");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  fs.mkdirSync(path.join(repo, "subfolder"));
  fs.writeFileSync(path.join(repo, "subfolder", "note.txt"), "original\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const { worktree, cwd } = await createSessionWorktree(path.join(repo, "subfolder"));
  f.c.cwd = cwd;
  f.c.worktree = worktree;
  f.c.additionalFolders = [repo];
  const control = f.store.conversation("control");
  control.cwd = repo;
  const worktreeFile = path.join(cwd, "note.txt");
  const repositoryFile = path.join(repo, "subfolder", "note.txt");
  fs.writeFileSync(worktreeFile, "worktree change\n");
  fs.writeFileSync(repositoryFile, "repository change\n");
  f.store.flush();
  t.after(registerGit({
    ctx: f.ctx,
    on: (name: string, fn: unknown) => f.native.set(name, fn),
    emit() {},
  } as never));
  return { ...f, git, worktree, worktreeFile, repositoryFile };
}

for (const action of ["archive", "delete"] as const)
  test(`original ${action} confirms only the listed dirty worktree`, async (t) => {
    const f = await dirtyWorktree(t);
    const options = {
      ...(action === "archive" ? { cleanupWorktree: true, forceWorktreeCleanup: true } : {}),
      discardChangesIn: [f.worktree.path],
    };
    await assert.rejects(f.run(action, options), /not listed with changes/);
    assert.equal(f.reopen().conversation("one").archived, false);
    const probe = f.native.get("LocalSessions.getUncommittedChangesByFolder");
    assert.equal(await probe("local_control"), null);
    assert.deepEqual(await f.run("getUncommittedChangesByFolder"), [{
      folder: f.worktree.origin,
      worktreePath: f.worktree.path,
      primary: true,
      changes: [" M subfolder/note.txt"],
    }]);
    await assert.rejects(f.run(action, { ...options, discardChangesIn: [f.worktree.repository] }));
    await f.run(action, options);
    assert.equal(fs.existsSync(f.worktree.path), false);
    assert.equal(fs.readFileSync(f.repositoryFile, "utf8"), "repository change\n");
    assert.match(f.git("branch", "--list", f.worktree.branch), /claude\//);
    if (action === "archive") {
      assert.equal(f.reopen().conversation("one").worktree?.state, "deleted");
      const row = await f.run("getSession");
      assert.equal(row.worktreePath, undefined);
      assert.equal(row.worktreeRemoved, true);
      await f.run("unarchive");
      assert.equal(fs.readFileSync(f.worktreeFile, "utf8"), "original\n");
    } else {
      assert.equal(f.reopen().conversations.some(c => c.id === "one"), false);
    }
  });

test("a kept worktree can be discarded from the archived session once it is no longer shared", async (t) => {
  const f = await dirtyWorktree(t);
  f.store.conversation("control").cwd = f.c.cwd;
  await f.run("getUncommittedChangesByFolder");
  await f.run("archive", { forceWorktreeCleanup: true, discardChangesIn: [f.worktree.path] });
  const row = await f.run("getSession");
  assert.equal(row.keptDirtyWorktree, true);
  assert.equal(row.worktreePath, f.worktree.path);
  assert.deepEqual(await f.run("discardKeptWorktree"), { outcome: "busy" });
  assert.equal(fs.readFileSync(f.worktreeFile, "utf8"), "worktree change\n");
  f.store.conversation("control").cwd = f.worktree.repository;
  assert.deepEqual(await f.run("discardKeptWorktree"), { outcome: "discarded" });
  assert.equal(f.reopen().conversation("one").archived, true);
  assert.equal(f.reopen().conversation("one").worktree?.state, "deleted");
  assert.equal(fs.existsSync(f.worktree.path), false);
  assert.equal(await f.run("getUncommittedChangesByFolder"), null);
});

function worktreeStartFixture(t: TestContext) {
  const f = fixture(t);
  const makeRepo = (name: string) => {
    const root = path.join(fs.realpathSync(f.root), name);
    const folder = path.join(root, "nested");
    fs.mkdirSync(folder, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    fs.writeFileSync(path.join(folder, "note.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    return { root, folder, git };
  };
  const primary = makeRepo("primary"), first = makeRepo("first"), second = makeRepo("second");
  const plain = path.join(f.root, "plain");
  fs.mkdirSync(plain);
  first.git("switch", "-qc", "alternate");
  fs.writeFileSync(path.join(first.folder, "note.txt"), "alternate\n");
  first.git("commit", "-qam", "alternate");
  first.git("switch", "-q", "main");
  f.store.settings.providers = [{
    id: "p", name: "Local", protocol: "responses",
    baseUrl: "http://127.0.0.1:1/v1", model: "m", models: ["m"],
  }];
  f.store.settings.activeProviderId = "p";
  const wire: { method: string; params: any }[] = [];
  const engine = new Engine(f.store, "unused", () => "", f.main.push);
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  Object.assign(engine, {
    windowsSandbox: { assertReady() {}, async ensureReady() {} },
    rpc: {
      connected: true,
      async call(method: string, params: unknown) {
        wire.push({ method, params });
        if (method === "thread/start") return { thread: { id: "new-thread" } };
        if (method === "turn/start") return { turn: { id: "new-turn" } };
        return {};
      },
    },
  });
  const chosen = new Set([primary.root, primary.folder, first.root, first.folder, second.folder, plain]);
  Object.assign(f.main, {
    engine,
    services: {},
    accountActivationIdentity: {},
    accountRetiring: false,
    selectedAttachments: new Map(),
    allowedFolder(cwd?: string) {
      if (cwd && !chosen.has(cwd) &&
          !f.store.conversations.some(c => c.cwd === cwd || ownsLocalCodeWorktreePath(c, cwd)))
        throw Error("Choose the working folder with the folder picker.");
    },
    noActive() {},
  });
  const handle = (name: string, fn: unknown) => f.ipc.set(name, fn);
  registerConversationHandlers(handle, f.main);
  registerOfficialGitHandlers(handle, f.main);
  t.after(registerGit({
    ctx: f.ctx,
    on: (name: string, fn: unknown) => f.native.set(name, fn),
    emit() {},
  } as never));
  const id = "local_b4e965cc-410d-461c-a235-64996fa2043a";
  return {
    ...f, engine, id, wire, primary, first, second, plain,
    local: (operation: string, ...args: unknown[]) => f.native.get("LocalSessions." + operation)(id, ...args),
    start: (useWorktree = true) => f.native.get("LocalSessions.start")({
      sessionId: id,
      cwd: primary.root,
      message: "Use the selected folders",
      permissionMode: "acceptEdits",
      useWorktree,
      additionalDirectories: [first.folder, first.root, second.folder, primary.folder, plain],
      additionalFolders: [
        { path: first.folder, useWorktree: true, sourceBranch: "alternate" },
        { path: first.root, useWorktree: true },
        { path: second.folder, useWorktree: true },
        { path: primary.folder, useWorktree: true },
        { path: plain, useWorktree: true },
      ],
    }).finally(() => f.store.flush()),
  };
}

test("Code start rejects a cached drawing model before sending and can retry with a conversation model", async t => {
  const f = worktreeStartFixture(t);
  f.store.settings.providers[0].models.push("gpt-image-2.5");
  const info = { sessionId: f.id, cwd: f.primary.root, message: "Inspect this workspace" };
  const start = f.native.get("LocalSessions.start");
  await assert.rejects(start({ ...info, model: "gpt-image-2.5" }), /Code model is unavailable/);
  assert.equal(f.wire.length, 0);
  assert.equal(f.store.conversations.some(c => c.id === f.id.slice(6)), false);

  assert.deepEqual(await start({ ...info, model: "m" }).finally(() => f.store.flush()), { sessionId: f.id });
  assert.ok(f.wire.some(row => row.method === "turn/start"));
  assert.equal(f.store.conversations.find(c => c.id === f.id.slice(6))?.model, "m");
});

test("the original branch picker stashes conflicting work and switches on start", async t => {
  const f = worktreeStartFixture(t);
  const { root, folder, git } = f.first;
  const branch = (method: string, ...args: string[]) =>
    f.native.get(`LocalSessions.${method}`)(root, ...args);
  git("tag", "main");
  assert.deepEqual(await branch("getLocalBranches"), ["alternate", "main"]);
  assert.equal((await branch("getGitInfo")).branch, "main");
  assert.deepEqual(await f.native.get("ClaudeCode.checkGitAvailable")(), {
    available: true, switchesBranchInFolder: true,
  });
  assert.equal(await branch("checkBranchSwitchConflict", "alternate"), false);
  fs.writeFileSync(path.join(folder, "independent.txt"), "unrelated\n");
  assert.equal(await branch("checkBranchSwitchConflict", "alternate"), false);
  fs.writeFileSync(path.join(folder, "note.txt"), "uncommitted\n");
  assert.equal(await branch("checkBranchSwitchConflict", "alternate"), true);
  assert.equal(await branch("isBranchOnOrigin", "alternate"), null);
  git("remote", "add", "origin", ".");
  assert.equal(await branch("isBranchOnOrigin", "alternate"), false);
  git("update-ref", "refs/remotes/origin/alternate", "refs/heads/alternate");
  assert.equal(await branch("isBranchOnOrigin", "alternate"), true);
  assert.deepEqual(await branch("stashWorkingTree", "epitaxy: pre-switch from main"), { success: true });
  assert.equal(git("branch", "--show-current").trim(), "main");
  assert.equal(fs.existsSync(path.join(folder, "independent.txt")), false);
  assert.deepEqual(await f.native.get("LocalSessions.start")({
    sessionId: f.id, cwd: root, sourceBranch: "alternate", message: "Use alternate",
  }).finally(() => f.store.flush()), { sessionId: f.id });
  assert.equal(git("branch", "--show-current").trim(), "alternate");
  assert.equal(fs.readFileSync(path.join(folder, "note.txt"), "utf8"), "alternate\n");
  assert.match(git("stash", "list"), /epitaxy: pre-switch from main/);
  assert.equal(f.wire.find(row => row.method === "thread/start")?.params.cwd, root);
});

test("a failed original branch switch restores its stash and starts no session", async t => {
  const f = worktreeStartFixture(t);
  const { root, folder, git } = f.first;
  git("worktree", "add", "-q", path.join(f.root, "occupied"), "alternate");
  fs.writeFileSync(path.join(folder, "note.txt"), "uncommitted\n");
  assert.deepEqual(await f.native.get("LocalSessions.stashWorkingTree")(
    root, "epitaxy: pre-switch from main",
  ), { success: true });
  await assert.rejects(f.native.get("LocalSessions.start")({
    sessionId: f.id, cwd: root, sourceBranch: "alternate", message: "Use alternate",
  }), /Failed to switch to "alternate"/);
  assert.equal(git("branch", "--show-current").trim(), "main");
  assert.equal(git("stash", "list").trim(), "");
  assert.equal(fs.readFileSync(path.join(folder, "note.txt"), "utf8"), "uncommitted\n");
  assert.equal(f.store.conversations.some(c => c.id === f.id.slice(6)), false);
  assert.equal(f.wire.length, 0);

  assert.deepEqual(await f.native.get("LocalSessions.stashWorkingTree")(
    root, "epitaxy: pre-switch from main",
  ), { success: true });
  fs.writeFileSync(path.join(folder, "note.txt"), "separate stash\n");
  git("stash", "push", "-m", "created outside Code");
  await assert.rejects(f.native.get("LocalSessions.start")({
    sessionId: f.id, cwd: root, sourceBranch: "alternate", message: "Use alternate",
  }), /Failed to switch to "alternate"/);
  assert.deepEqual(git("stash", "list", "--format=%s").trim().split(/\r?\n/), [
    "On main: created outside Code", "On main: epitaxy: pre-switch from main",
  ]);
  assert.equal(fs.readFileSync(path.join(folder, "note.txt"), "utf8"), "base\n");
});

test("the original dirty tree actions write a WIP commit or discard the working changes", async t => {
  const f = worktreeStartFixture(t);
  const { root, folder, git } = f.first;
  const commit = f.native.get("LocalSessions.commitWipForBranchSwitch");
  const discard = f.native.get("LocalSessions.discardWorkingTree");
  const note = path.join(folder, "note.txt");
  fs.writeFileSync(note, "save this\n");
  assert.deepEqual(await commit(root, "main"), { success: true });
  assert.equal(git("log", "-1", "--format=%s").trim(), "WIP: epitaxy pre-switch from main");
  assert.deepEqual(await commit(root, "main"), { success: true });
  fs.writeFileSync(note, "discard this\n");
  const loose = path.join(root, "untracked.txt");
  fs.writeFileSync(loose, "remove this\n");
  await assert.rejects(discard(path.join(f.root, "not-selected")), /folder picker/);
  assert.deepEqual(await discard(folder), { success: true });
  assert.equal(fs.readFileSync(note, "utf8"), "save this\n");
  assert.equal(fs.existsSync(loose), false);
});

test("original Code start maps multiple real Git worktrees and probes each owned checkout", async t => {
  const f = worktreeStartFixture(t);
  assert.deepEqual(await f.start(), { sessionId: f.id });
  const c = f.store.conversation(f.id.slice(6));
  const row = await f.local("getSession");
  const [first, alias, second] = row.folderWorktrees;
  assert.equal(row.folderWorktrees.length, 3);
  assert.equal(first.folder, f.first.folder);
  assert.equal(first.repoRoot, f.first.root);
  assert.equal(first.sourceBranch, "alternate");
  assert.equal(alias.folder, f.first.root);
  assert.equal(alias.worktreePath, first.worktreePath);
  assert.equal(second.folder, f.second.folder);
  assert.notEqual(first.worktreePath, second.worktreePath);
  assert.equal(fs.readFileSync(path.join(first.worktreePath, "nested", "note.txt"), "utf8"), "alternate\n");
  const roots = [path.join(first.worktreePath, "nested"), first.worktreePath,
    path.join(second.worktreePath, "nested"), f.primary.folder, f.plain];
  assert.deepEqual(row.additionalDirectories, roots);
  assert.deepEqual(f.wire.find(row => row.method === "turn/start")?.params.sandboxPolicy.writableRoots, [c.cwd, ...roots]);
  for (const tree of [first, second]) {
    const git = await f.native.get("LocalSessions.getGitInfo")(tree.worktreePath);
    assert.equal(git.branch, tree.branch);
    fs.writeFileSync(path.join(tree.worktreePath, "nested", "note.txt"), "edited\n");
  }
  await assert.rejects(f.native.get("LocalSessions.getGitInfo")(f.second.root), /folder picker/);
  assert.deepEqual(await f.local("getUncommittedChanges"), []);
  assert.deepEqual(await f.local("getUncommittedChangesByFolder"), [
    { folder: f.primary.root, worktreePath: c.worktree?.path, primary: true, changes: [] },
    { folder: f.first.folder, worktreePath: first.worktreePath, changes: [" M nested/note.txt"] },
    { folder: f.second.folder, worktreePath: second.worktreePath, changes: [" M nested/note.txt"] },
  ]);
  c.turns[0].status = "completed";
  await f.local("archive", { forceWorktreeCleanup: true, discardChangesIn: [first.worktreePath, second.worktreePath] });
  assert.equal(fs.existsSync(first.worktreePath), false);
  assert.equal(fs.existsSync(second.worktreePath), false);
  assert.equal(await f.local("getUncommittedChangesByFolder"), null);
  assert.equal(f.reopen().conversation(c.id).additionalWorktrees?.every(tree => tree.state === "deleted"), true);
  await f.local("unarchive");
  assert.equal(f.reopen().conversation(c.id).additionalWorktrees?.every(tree => tree.state === undefined), true);
  assert.equal(fs.readFileSync(path.join(first.worktreePath, "nested", "note.txt"), "utf8"), "alternate\n");
  assert.equal(fs.readFileSync(path.join(second.worktreePath, "nested", "note.txt"), "utf8"), "base\n");
});

test("first-turn preparation failure removes every newly created checkout and branch", async t => {
  const f = worktreeStartFixture(t);
  f.engine.ensure = async () => { throw Error("fixture cannot prepare the engine"); };
  await assert.rejects(f.start(), /fixture cannot prepare the engine/);
  assert.deepEqual(f.wire, []);
  const c = f.store.conversation(f.id.slice(6));
  assert.equal(c.cwd, f.primary.root);
  assert.equal(c.worktree, undefined);
  assert.equal(c.additionalWorktrees, undefined);
  for (const repo of [f.primary, f.first, f.second]) {
    assert.equal(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    assert.equal(repo.git("branch", "--list", "claude/*"), "");
  }
});

test("stopping a Code start after checkout publishes the original folders and releases every lease", async t => {
  const f = worktreeStartFixture(t);
  const entered = deferred(), release = deferred();
  f.engine.ensure = async () => {
    entered.resolve();
    await release.promise;
  };
  const stopped = assert.rejects(f.start(), /spawn-cancelled/);
  await entered.promise;
  const c = f.store.conversation(f.id.slice(6));
  const worktrees = [c.worktree, ...(c.additionalWorktrees ?? [])];
  assert.equal(worktrees.length, 3);
  try {
    await f.local("interrupt");
  } finally {
    release.resolve();
    await stopped;
  }
  assert.deepEqual(f.wire, []);
  assert.ok(worktrees.every(tree => tree && !fs.existsSync(tree.path)));
  const event = f.events.filter(e => e.type === "conversation" && e.conversation.id === c.id).at(-1);
  assert.equal(event.conversation.cwd, f.primary.root);
  assert.equal(event.conversation.additionalWorktrees, undefined);
  assert.equal(event.conversation.turns[0].status, "interrupted");
});

test("a primary-only checkout is rolled back when native start fails before dispatch", async t => {
  const f = worktreeStartFixture(t);
  f.engine.ensure = async () => { throw Error("fixture cannot prepare the engine"); };
  await assert.rejects(f.native.get("LocalSessions.start")({
    sessionId: f.id,
    cwd: f.primary.root,
    message: "Run this in a worktree",
    useWorktree: true,
  }).finally(() => f.store.flush()), /fixture cannot prepare the engine/);
  assert.equal(f.reopen().conversation(f.id.slice(6)).worktree, undefined);
  assert.equal(f.primary.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  assert.equal(f.primary.git("branch", "--list", "claude/*"), "");
});

test("original archive accepts an unreadable additional checkout without discarding changes", async t => {
  const f = worktreeStartFixture(t);
  await f.start(false);
  const c = f.store.conversation(f.id.slice(6));
  const [first, second] = (await f.local("getSession")).folderWorktrees
    .filter((tree: { folder: string }) => tree.folder !== f.first.root);
  assert.equal(c.cwd, f.primary.root);
  assert.equal(await f.local("getUncommittedChanges"), null);
  f.second.git("worktree", "remove", second.worktreePath);
  assert.deepEqual(await f.local("getUncommittedChangesByFolder"), [
    { folder: f.first.folder, worktreePath: first.worktreePath, changes: [] },
    { folder: f.second.folder, worktreePath: second.worktreePath, unreadable: true },
  ]);
  c.turns[0].status = "completed";
  fs.writeFileSync(path.join(first.worktreePath, "nested", "note.txt"), "changed while the dialog was open\n");
  await f.local("archive", { forceWorktreeCleanup: true, discardChangesIn: [] });
  const archived = await f.local("getSession");
  assert.equal(archived.keptDirtyWorktree, true);
  assert.equal(archived.folderWorktrees.find((tree: { folder: string }) => tree.folder === f.second.folder).removed, true);
  assert.equal(fs.readFileSync(path.join(first.worktreePath, "nested", "note.txt"), "utf8"),
    "changed while the dialog was open\n");
  assert.deepEqual(await f.local("discardKeptWorktree"), { outcome: "discarded" });
  assert.equal(fs.existsSync(first.worktreePath), false);
});

test("additional worktree startup reports a failed checkout and leaves its folder in place", async t => {
  const f = worktreeStartFixture(t);
  const location = path.join(fs.realpathSync(f.root), "managed");
  fs.mkdirSync(location);
  fs.writeFileSync(path.join(location, "second"), "occupies the checkout parent");
  f.store.settings.codeWorktreeLocation = location;
  await f.start();
  const row = await f.local("getSession");
  assert.ok(row.additionalDirectories.includes(f.second.folder));
  assert.equal(row.folderWorktrees.some((tree: { folder: string }) => tree.folder === f.second.folder), false);
  const transcript = await f.local("getTranscript");
  const notice = transcript.find((entry: { subtype?: string }) => entry.subtype === "local_command_output");
  assert.equal(notice?.content, `<local-command-stdout>A worktree couldn’t be created for \`${f.second.folder}\`, so this session uses that folder in place.</local-command-stdout>`);
  const stored = f.reopen().conversation(f.id.slice(6));
  assert.ok(stored.turns[0].items.some(item => item.text?.includes("this session uses that folder in place")));
});

test("primary worktree startup distinguishes a missing source branch from an unusable repository", async t => {
  for (const hasCommit of [true, false]) {
    const f = worktreeStartFixture(t);
    if (!hasCommit) f.primary.git("update-ref", "-d", "refs/heads/main");
    const started = f.native.get("LocalSessions.start")({
      sessionId: f.id,
      cwd: f.primary.root,
      message: "Start on the chosen branch",
      useWorktree: true,
      sourceBranch: "removed-source",
    }).finally(() => f.store.flush());
    if (!hasCommit) {
      await assert.rejects(started, /no commits/);
      assert.deepEqual(f.wire, []);
      continue;
    }
    await started;
    const row = await f.local("getSession");
    assert.equal(row.sourceBranch, "main");
    assert.equal(row.branch, f.primary.git("-C", row.worktreePath, "branch", "--show-current").trim());
    const transcript = await f.local("getTranscript");
    assert.ok(transcript.some((entry: { content?: string }) =>
      entry.content?.includes("Branch `removed-source` couldn't be used")));
  }
});

test("an untrusted worktree selection is dropped and explained in the original transcript", async t => {
  const f = worktreeStartFixture(t);
  f.main.services.workspaceTrust = {
    assert({ cwd }: { cwd?: string }) {
      if (cwd === f.first.folder) throw Error("The folder has not been trusted.");
    },
  };
  await f.start();
  const row = await f.local("getSession");
  assert.equal(row.additionalDirectories.includes(f.first.folder), false);
  assert.equal(row.additionalDirectories.includes(f.first.root), false);
  const transcript = await f.local("getTranscript");
  assert.ok(transcript.some((entry: { content?: string }) =>
    entry.content?.includes("isn’t a trusted folder, so it was left out")));
});

test("an externally removed primary checkout recovers or falls back before the next native send", async t => {
  for (const keepBranch of [true, false]) {
    const f = worktreeStartFixture(t);
    await f.start();
    const c = f.store.conversation(f.id.slice(6));
    const checkout = c.worktree!;
    c.turns[0].status = "completed";
    if (keepBranch) fs.rmSync(checkout.path, { recursive: true });
    else {
      f.primary.git("worktree", "remove", checkout.path);
      f.primary.git("branch", "-D", checkout.branch);
    }
    const extra = c.additionalWorktrees![1];
    f.second.git("worktree", "remove", extra.path);
    await f.local("sendMessage", "Continue after moving the workspace").finally(() => f.store.flush());
    assert.equal(f.wire.filter(entry => entry.method === "turn/start").length, 2);
    const row = await f.local("getSession");
    assert.equal(row.cwd, keepBranch ? checkout.path : f.primary.root);
    assert.equal(fs.existsSync(checkout.path), keepBranch);
    assert.equal(row.additionalDirectories.includes(f.second.folder), true);
    assert.equal(row.additionalDirectories.includes(extra.folders[0].cwd), false);
    const transcript = await f.local("getTranscript");
    assert.ok(transcript.some((entry: { content?: string }) => entry.content?.includes("uses that folder in place")));
    assert.equal(transcript.some((entry: { content?: string }) =>
      entry.content?.includes(`now runs in the main repository at \`${f.primary.root}\` without a worktree`)), !keepBranch);
  }
});

for (const linked of [false, true])
  test(`a listed worktree replaced by ${linked ? "another linked checkout" : "an ordinary folder"} is preserved`, async t => {
    const f = await dirtyWorktree(t);
    await f.run("getUncommittedChangesByFolder");
    if (linked) {
      f.git("worktree", "remove", "--force", f.worktree.path);
      f.git("worktree", "add", "-b", "other-work", f.worktree.path);
    } else {
      fs.rmSync(f.worktree.path, { recursive: true });
      fs.mkdirSync(f.worktree.path);
    }
    const ordinaryFile = path.join(f.worktree.path, "ordinary.txt");
    fs.writeFileSync(ordinaryFile, "keep this file");
    await f.run("archive", { forceWorktreeCleanup: true, discardChangesIn: [f.worktree.path] });
    assert.deepEqual(await f.run("discardKeptWorktree"), { outcome: "failed" });
    await assert.rejects(f.run("unarchive"), /occupies the Code worktree path/);
    assert.equal(f.reopen().conversation("one").archived, true);
    assert.equal(fs.readFileSync(ordinaryFile, "utf8"), "keep this file");
  });

test("archive keeps a checkout when requested and restores the exact merged branch tip", async t => {
  const f = worktreeStartFixture(t);
  await f.start();
  const c = f.store.conversation(f.id.slice(6));
  const checkout = c.worktree!;
  c.turns[0].status = "completed";
  await f.local("archive", { cleanupWorktree: false });
  assert.ok(fs.existsSync(checkout.path));
  assert.equal(f.reopen().conversation(c.id).worktree?.state, undefined);
  await f.local("unarchive");
  const remote = path.join(f.root, "bare");
  f.primary.git("init", "--bare", remote);
  f.primary.git("remote", "add", "origin", remote);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout.path, encoding: "utf8" });
  fs.writeFileSync(path.join(checkout.path, "merged.txt"), "published content");
  git("add", "merged.txt");
  git("commit", "-qm", "merge candidate");
  const tip = git("rev-parse", "HEAD").trim();
  f.primary.git("push", "origin", checkout.branch);
  await f.ipc.get("updateConversation")(c.id, { archived: true, prMerged: true });
  assert.equal(f.primary.git("branch", "--list", checkout.branch), "");
  assert.equal(f.reopen().conversation(c.id).worktree?.archivedBranchTip, tip);
  await f.local("unarchive");
  assert.equal(git("rev-parse", "HEAD").trim(), tip);
  assert.equal(f.reopen().conversation(c.id).worktree?.archivedBranchTip, undefined);
  assert.equal(fs.readFileSync(path.join(checkout.path, "merged.txt"), "utf8"), "published content");
});
