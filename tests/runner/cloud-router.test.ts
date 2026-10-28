import test from "node:test";
import assert from "node:assert/strict";
import type { AppEvent, Conversation, Snapshot } from "../../shared/types";
import {
  CloudRouter,
  type CloudCalls,
  type CloudRouterDeps,
} from "../../electron/cloud/cloud-router";
import { cloudSnapshotTimeoutMs } from "../../electron/cloud/cloud-router-support";

const conversation = (id: string, mode = "chat") =>
  ({ id, mode, title: id, turns: [] }) as unknown as Conversation;

const snapshot = (part: Partial<Snapshot>) =>
  ({
    conversations: [],
    projects: [],
    approvals: [],
    ...part,
  }) as unknown as Snapshot;

test("failed computer handoff releases the cloud claim", async () => {
  const { router, calls } = setup();
  const link = router.route("linkCoworkTaskToComputer", async () => {
    throw new Error("disk full");
  });
  await assert.rejects(link("cowork-task"), /disk full/);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["exportCoworkTask", "releaseCoworkTask"],
  );
  assert.deepEqual(calls[0].args, [
    "cowork-task",
    { id: "pc-computer1", name: "My Mac" },
  ]);
});

test("a locally linked task stays local across cloud snapshot refreshes", async () => {
  const cloud = conversation("linked", "cowork");
  const { router } = setup({ conversations: [cloud] });
  const linked = {
    ...cloud,
    linkedToComputer: true,
    environment: { kind: "local" as const },
  };
  const merged = await router.merge(snapshot({ conversations: [linked] }));
  assert.equal(merged.conversations.length, 1);
  assert.equal(merged.conversations[0].environment?.kind, "local");
  assert.equal(
    await router.route(
      "send",
      async () => "local",
    )({ conversationId: "linked" }),
    "local",
  );
});

test("computer handoff asks for sign-in before claiming a task when disconnected", async () => {
  const state = setup();
  state.setOnline(false);
  await assert.rejects(
    state.router.route("linkCoworkTaskToComputer", async () => {})(
      "cowork-task",
    ),
    /Sign in to Claudex again/,
  );
  assert.deepEqual(state.calls, []);
});

function setup(
  cloudState: Partial<Snapshot> = {},
  deps: Partial<CloudRouterDeps> = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const pushed: AppEvent[] = [];
  const timers: Array<() => void> = [];
  let online = true;
  let failSnapshot = false;
  const answers: Record<string, (args: unknown[]) => unknown> = {
    send: (args) => conversation("c-new"),
    addAttachmentData: (args) => ({
      id: `cloud-${args[0]}`,
      name: args[0],
      path: "/cloud",
      kind: "text",
      size: 1,
    }),
  };
  const client = {
    call: async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      return answers[method]?.(args) ?? `cloud:${method}`;
    },
    snapshot: async () => {
      if (failSnapshot) throw new Error("offline");
      return { snapshot: snapshot(cloudState) };
    },
  };
  const router = new CloudRouter({
    device: () => ({ id: "pc-computer1", name: "My Mac" }),
    client: () => (online ? client : undefined),
    push: (event) => pushed.push(event),
    attachmentBytes: async (id) =>
      id === "local-1"
        ? { name: "notes.txt", data: new Uint8Array([104, 105]) }
        : undefined,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    ...deps,
  });
  const local =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ method: `local:${name}`, args });
      return `local:${name}`;
    };
  return {
    router,
    calls,
    pushed,
    timers,
    local,
    setOnline: (value: boolean) => (online = value),
    setFailSnapshot: (value: boolean) => (failSnapshot = value),
  };
}

const localSnapshot = snapshot({
  conversations: [conversation("l-1", "code"), conversation("moved")],
  projects: [{ id: "p-local", name: "Local", cwd: "/repo" } as never],
  approvals: [{ id: 3, conversationId: "l-1" } as never],
});

test("linked GitHub repositories cross into the cloud as links, not uploaded snapshots", async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const github = { repository: "octo/repo", branch: "feature/work" };
  const attachment = {
    id: "cloud-link",
    name: github.repository,
    path: "",
    kind: "text",
    size: 100,
    github,
  };
  const router = new CloudRouter({
    client: () => ({
      snapshot: async () => ({ snapshot: snapshot({}) }),
      call: async (method, args = []) => {
        calls.push({ method, args });
        return method === "linkChatGitHubRepository"
          ? attachment
          : conversation("cloud-chat");
      },
    }),
    push: () => {},
    attachmentBytes: async () => ({
      name: github.repository,
      data: Buffer.from(
        JSON.stringify({ claudexGitHubRepository: true, ...github }),
      ),
    }),
  });
  await router.route("send", async () => {
    throw Error("must use the cloud");
  })({
    mode: "chat",
    text: "Review this",
    attachments: [{ id: "local-link" }],
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["linkChatGitHubRepository", "send"],
  );
  assert.deepEqual(calls[0].args, [github.repository, github.branch]);
  assert.deepEqual(
    (calls[1].args[0] as { attachments: unknown[] }).attachments,
    [attachment],
  );
});

test("cloud environment CRUD reaches the runner while syncing and the account's local store while offline", async () => {
  const env = setup();
  for (const method of [
    "listCloudEnvironments",
    "saveCloudEnvironment",
    "archiveCloudEnvironment",
  ]) {
    assert.equal(
      await env.router.route(method, env.local(method))("profile"),
      `cloud:${method}`,
    );
    env.setOnline(false);
    assert.equal(
      await env.router.route(method, env.local(method))("profile"),
      `local:${method}`,
    );
    env.setOnline(true);
  }
});

test("the snapshot is the local part plus the cloud's, a moved conversation once", async () => {
  const t = setup({
    conversations: [conversation("c-1"), conversation("moved")],
    projects: [{ id: "p-cloud", name: "Cloud" } as never],
    approvals: [{ id: 3, conversationId: "c-1" } as never],
  });
  const merged = await t.router.route("snapshot", async () => localSnapshot)();
  assert.deepEqual(
    merged.conversations.map((c: Conversation) => c.id),
    ["l-1", "c-1", "moved"],
  );
  assert.deepEqual(
    merged.projects.map((p: { id: string }) => p.id),
    ["p-local", "p-cloud"],
  );
  assert.deepEqual(
    merged.approvals.map((a: { id: unknown }) => a.id),
    [3, "cloud:3"],
  );
  assert.ok(t.router.isCloudConversation("c-1"));
  assert.ok(!t.router.isCloudConversation("l-1"));
});

test("a conversation's calls go where it lives", async () => {
  const t = setup({
    conversations: [conversation("c-1")],
    projects: [{ id: "p-cloud", name: "Cloud" } as never],
  });
  await t.router.route("snapshot", async () => localSnapshot)();
  const update = t.router.route(
    "updateConversation",
    t.local("updateConversation"),
  );
  assert.equal(
    await update("c-1", { pinned: true }),
    "cloud:updateConversation",
  );
  assert.equal(
    await update("l-1", { pinned: true }),
    "local:updateConversation",
  );
  const mention = t.router.route("mentionFiles", t.local("mentionFiles"));
  assert.equal(
    await mention({ conversationId: "c-1" }, "a"),
    "cloud:mentionFiles",
  );
  assert.equal(await mention({ folder: "/x" }, "a"), "local:mentionFiles");
  const project = t.router.route(
    "listProjectKnowledge",
    t.local("listProjectKnowledge"),
  );
  assert.equal(await project("p-local"), "local:listProjectKnowledge");
  const read = t.router.route(
    "readProjectKnowledge",
    t.local("readProjectKnowledge"),
  );
  assert.equal(await read("p-local", "notes.md"), "local:readProjectKnowledge");
  assert.equal(await read("p-cloud", "notes.md"), "cloud:readProjectKnowledge");
  // A cloud conversation's folders and terminals are the runner's: asked of the
  // local store they were "not found".
  for (const name of ["coworkFolders", "listBackgroundTerminals"]) {
    const call = t.router.route(name, t.local(name));
    assert.equal(await call("c-1"), `cloud:${name}`);
    assert.equal(await call("l-1"), `local:${name}`);
  }
});

test("a new Chat starts in the cloud, with its attachments uploaded there", async () => {
  const t = setup();
  await t.router.route("snapshot", async () => localSnapshot)();
  const send = t.router.route("send", t.local("send"));
  const result = await send({
    text: "hi",
    mode: "chat",
    cwd: "/Users/me",
    attachments: [
      {
        id: "local-1",
        name: "notes.txt",
        path: "/tmp/notes.txt",
        kind: "text",
        size: 2,
      },
    ],
    providerId: "sub2api",
    model: "m",
  });
  assert.equal((result as Conversation).id, "c-new");
  assert.ok(t.router.isCloudConversation("c-new"));
  const upload = t.calls.find((c) => c.method === "addAttachmentData")!;
  assert.equal(upload.args[0], "notes.txt");
  assert.deepEqual([...(upload.args[1] as Uint8Array)], [104, 105]);
  const sent = t.calls.find((c) => c.method === "send")!.args[0] as Record<
    string,
    unknown
  >;
  assert.equal(
    sent.cwd,
    undefined,
    "a local folder means nothing in the cloud",
  );
  assert.deepEqual(
    (sent.attachments as Array<{ id: string }>).map((a) => a.id),
    ["cloud-notes.txt"],
  );
});

test("where each new conversation starts", async () => {
  const t = setup({ projects: [{ id: "p-cloud", name: "Cloud" } as never] });
  await t.router.route("snapshot", async () => localSnapshot)();
  const send = t.router.route("send", t.local("send"));
  const base = {
    text: "x",
    attachments: [],
    providerId: "sub2api",
    model: "m",
  };
  const where = async (input: Record<string, unknown>) => {
    t.calls.length = 0;
    await send({ ...base, ...input });
    return t.calls.some((c) => c.method === "send") ? "cloud" : "local";
  };
  assert.equal(await where({ mode: "code", cwd: "/repo" }), "local");
  assert.equal(
    await where({
      mode: "code",
      repository: { fullName: "a/b" },
      cwd: "/repo",
    }),
    "cloud",
  );
  assert.equal(
    await where({ mode: "cowork", cwd: "/Users/me/Desktop" }),
    "cloud",
  );
  assert.equal(await where({ mode: "chat", incognito: true }), "local");
  assert.equal(await where({ mode: "chat", projectId: "p-local" }), "local");
  assert.equal(await where({ mode: "chat", projectId: "p-cloud" }), "cloud");
  // Cowork is cloud-only: a local project is left behind.
  t.calls.length = 0;
  await send({ ...base, mode: "cowork", projectId: "p-local" });
  const sent = t.calls.find((c) => c.method === "send")!.args[0] as Record<
    string,
    unknown
  >;
  assert.equal(sent.projectId, undefined);
  // Signed out of the cloud: everything stays local.
  t.setOnline(false);
  assert.equal(await where({ mode: "chat" }), "local");
});

test("a cloud approval's id carries a prefix both ways", async () => {
  const t = setup();
  t.router.cloudEvent({
    type: "approval",
    approval: { id: 7, conversationId: "c-1" } as never,
  });
  assert.equal(
    (t.pushed[0] as { approval: { id: unknown } }).approval.id,
    "cloud:7",
  );
  const approve = t.router.route("approve", t.local("approve"));
  await approve("cloud:7", { decision: "accept" });
  assert.deepEqual(t.calls.at(-1), {
    method: "approve",
    args: [7, { decision: "accept" }],
  });
  await approve(7, { decision: "accept" });
  assert.equal(t.calls.at(-1)!.method, "local:approve");
  t.router.cloudEvent({ type: "approval-resolved", id: 7 });
  assert.deepEqual(t.pushed.at(-1), {
    type: "approval-resolved",
    id: "cloud:7",
  });
});

test("cloud events about conversations reach the window; the app's own kinds do not", async () => {
  const t = setup();
  t.router.cloudEvent({
    type: "conversation",
    conversation: conversation("c-9"),
  });
  t.router.cloudEvent({ type: "engine", engine: { state: "ready" } });
  t.router.cloudEvent({ type: "stream-connection", connected: true });
  assert.deepEqual(
    t.pushed.map((e) => e.type),
    ["conversation", "resync"],
  );
  assert.ok(t.router.isCloudConversation("c-9"));
});

test("a cloud conversation's side chat answer reaches the window as it is written", () => {
  const t = setup();
  const event = {
    type: "side-chat-text" as const,
    conversationId: "c-9",
    sideChatId: "s1",
    text: "So far.",
  };
  t.router.cloudEvent(event);
  assert.deepEqual(t.pushed, [event]);
});

test("an unreachable cloud shows the last known list and asks again later", async () => {
  const t = setup({ conversations: [conversation("c-1")] });
  await t.router.route("snapshot", async () => localSnapshot)();
  t.setFailSnapshot(true);
  const merged = await t.router.route("snapshot", async () => localSnapshot)();
  assert.ok(merged.conversations.some((c: Conversation) => c.id === "c-1"));
  assert.equal(t.timers.length >= 1, true);
  t.timers.at(-1)!();
  assert.deepEqual(t.pushed.at(-1), { type: "resync" });

  const fresh = setup();
  fresh.setFailSnapshot(true);
  const local = await fresh.router.route(
    "snapshot",
    async () => localSnapshot,
  )();
  assert.deepEqual(local, {
    ...localSnapshot,
    projectCatalog: { status: "failed", cached: false },
  });
});

test("project catalogue partial failure keeps local rows and reports whether a cloud read ever succeeded", async () => {
  const t = setup({
    projects: [{ id: "cloud-project", name: "Cloud project" } as never],
  });
  const local = snapshot({
    projects: [{ id: "local-project", name: "Local project" } as never],
  });
  t.setFailSnapshot(true);
  const first = await t.router.merge(local);
  assert.deepEqual(
    first.projects.map((p) => p.id),
    ["local-project"],
  );
  assert.deepEqual(first.projectCatalog, { status: "failed", cached: false });
  t.setFailSnapshot(false);
  const fresh = await t.router.merge(local);
  assert.deepEqual(
    fresh.projects.map((p) => p.id),
    ["local-project", "cloud-project"],
  );
  assert.deepEqual(fresh.projectCatalog, { status: "ready", cached: true });
  t.setFailSnapshot(true);
  const cached = await t.router.merge(local);
  assert.deepEqual(
    cached.projects.map((p) => p.id),
    ["local-project", "cloud-project"],
  );
  assert.deepEqual(cached.projectCatalog, { status: "failed", cached: true });
});

test("a successful empty cloud catalogue still counts as cache, and reset forgets it", async () => {
  const t = setup();
  const empty = snapshot({});
  const first = await t.router.merge(empty);
  assert.deepEqual(first.projectCatalog, { status: "ready", cached: true });
  t.setFailSnapshot(true);
  const failed = await t.router.merge(empty);
  assert.deepEqual(failed.projects, []);
  assert.deepEqual(failed.projectCatalog, { status: "failed", cached: true });
  t.router.reset();
  const reset = await t.router.merge(empty);
  assert.deepEqual(reset.projectCatalog, { status: "failed", cached: false });
});

test("a local-only snapshot remains ready without inventing a cloud failure", async () => {
  const t = setup();
  t.setOnline(false);
  const local = snapshot({});
  assert.equal(await t.router.merge(local), local);
  assert.equal(local.projectCatalog, undefined);
});

test("a whole local snapshot failure rejects before any partial-cloud metadata exists", async () => {
  const t = setup();
  await assert.rejects(
    t.router.route("snapshot", async () => {
      throw Error("local snapshot failed");
    })(),
    /local snapshot failed/,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshotRace(client: CloudCalls, claims?: CloudRouterDeps["claims"]) {
  let active = client;
  let beforeRead: (() => void) | undefined;
  let completed = 0;
  let nextTimer = 0;
  const events: AppEvent[] = [];
  const timers = new Map<
    number,
    { callback(): void; ms: number; active: boolean }
  >();
  const cleared: unknown[] = [];
  const router = new CloudRouter({
    client: () => {
      beforeRead?.();
      return active;
    },
    push: (event) => events.push(event),
    attachmentBytes: async () => undefined,
    onCloudSnapshot: () => completed++,
    claims,
    setTimeout(callback, ms) {
      const id = ++nextTimer;
      timers.set(id, { callback, ms, active: true });
      return id;
    },
    clearTimeout(handle) {
      cleared.push(handle);
      const timer = timers.get(handle as number);
      if (timer) timer.active = false;
    },
  });
  return {
    router,
    events,
    timers,
    cleared,
    completed: () => completed,
    setClient: (value: CloudCalls) => (active = value),
    beforeRead: (callback?: () => void) => (beforeRead = callback),
    fire(id: number) {
      const timer = timers.get(id)!;
      timer.active = false;
      timer.callback();
    },
    timer(ms: number) {
      return [...timers].reverse().find(([, value]) => value.ms === ms)![0];
    },
  };
}

const ownerSnapshot = (owner: string) =>
  snapshot({
    projects: [{ id: `${owner}-project`, name: owner } as never],
    conversations: [conversation(`${owner}-conversation`)],
  });

for (const settlement of ["resolve", "reject", "timeout"] as const)
  test(`a snapshot ${settlement} after reset cannot refill the next account cache, touch its retry or recover claims`, async () => {
    const pending = deferred<{ snapshot: Snapshot }>();
    let claimReads = 0;
    const a: CloudCalls = {
      call: async () =>
        assert.fail("an expired snapshot must not recover claims"),
      snapshot: () => pending.promise,
    };
    const t = snapshotRace(a, {
      list() {
        claimReads++;
        return ["old-claim"];
      },
      add() {},
      remove() {
        assert.fail("an expired snapshot must not edit the claim ledger");
      },
    });
    const localA = ownerSnapshot("a-local");
    const oldRead = t.router.merge(localA);
    const oldTimeout = t.timer(cloudSnapshotTimeoutMs);
    t.router.reset();
    t.setClient({
      call: async () => undefined,
      snapshot: async () => {
        throw Error("synthetic B offline");
      },
    });
    const localB = ownerSnapshot("b-local");
    await t.router.merge(localB);
    const retryB = t.timer(15_000);
    if (settlement === "resolve")
      pending.resolve({ snapshot: ownerSnapshot("a-cloud") });
    else if (settlement === "reject") pending.reject(Error("late A rejection"));
    else t.fire(oldTimeout);
    assert.equal(
      await oldRead,
      localA,
      "the old caller must not receive B's cache",
    );
    assert.equal(t.completed(), 0);
    assert.equal(claimReads, 0);
    assert.equal(t.router.isCloudProject("a-cloud-project"), false);
    assert.equal(t.router.isCloudConversation("a-cloud-conversation"), false);
    assert.equal(t.timers.get(retryB)?.active, true);
    assert.equal(t.cleared.includes(retryB), false);
    assert.equal(
      [...t.timers.values()].filter((timer) => timer.ms >= 15_000).length,
      1,
    );
    const nextB = await t.router.merge(localB);
    assert.deepEqual(nextB.projects, localB.projects);
    assert.deepEqual(nextB.projectCatalog, { status: "failed", cached: false });
  });

test("a replaced client retires its pending snapshot even before another merge or explicit reset", async () => {
  const pending = deferred<{ snapshot: Snapshot }>();
  const t = snapshotRace({
    call: async () => undefined,
    snapshot: () => pending.promise,
  });
  const local = ownerSnapshot("old-local");
  const oldRead = t.router.merge(local);
  t.setClient({
    call: async () => undefined,
    snapshot: async () => ({ snapshot: ownerSnapshot("b") }),
  });
  pending.resolve({ snapshot: ownerSnapshot("a") });
  assert.equal(await oldRead, local);
  assert.equal(t.completed(), 0);
  assert.equal(t.router.isCloudProject("a-project"), false);
  const fresh = await t.router.merge(snapshot({}));
  assert.deepEqual(
    fresh.projects.map((project) => project.id),
    ["b-project"],
  );
});

test("the production-style lazy client getter may reset before an awaited snapshot writes any state", async () => {
  const pending = deferred<{ snapshot: Snapshot }>();
  const t = snapshotRace({
    call: async () => undefined,
    snapshot: () => pending.promise,
  });
  const local = ownerSnapshot("old-local");
  const oldRead = t.router.merge(local);
  t.beforeRead(() => {
    t.beforeRead(undefined);
    t.router.reset();
    t.setClient({
      call: async () => undefined,
      snapshot: async () => ({ snapshot: ownerSnapshot("b") }),
    });
  });
  pending.resolve({ snapshot: ownerSnapshot("a") });
  assert.equal(await oldRead, local);
  assert.equal(t.completed(), 0);
  assert.equal(t.router.isCloudProject("a-project"), false);
});

for (const settlement of ["resolve", "reject", "timeout"] as const)
  test(`an older concurrent snapshot ${settlement} cannot overwrite a newer same-account cache or schedule retries`, async () => {
    const pending = deferred<{ snapshot: Snapshot }>();
    let reads = 0;
    const client: CloudCalls = {
      call: async () => undefined,
      snapshot: () =>
        ++reads === 1
          ? pending.promise
          : Promise.resolve({ snapshot: ownerSnapshot("new") }),
    };
    const t = snapshotRace(client);
    const localA = ownerSnapshot("window-a-local");
    const localB = ownerSnapshot("window-b-local");
    const oldRead = t.router.merge(localA);
    const oldTimeout = t.timer(cloudSnapshotTimeoutMs);
    const newerCaller = await t.router.merge(localB);
    assert.deepEqual(
      newerCaller.projects.map((project) => project.id),
      ["window-b-local-project", "new-project"],
    );
    if (settlement === "resolve")
      pending.resolve({ snapshot: ownerSnapshot("old") });
    else if (settlement === "reject")
      pending.reject(Error("late old rejection"));
    else t.fire(oldTimeout);
    const olderCaller = await oldRead;
    assert.deepEqual(
      olderCaller.projects.map((project) => project.id),
      [
        "window-a-local-project",
        settlement === "resolve" ? "old-project" : "new-project",
      ],
      "a caller in another window must retain a real cloud result or the valid cache",
    );
    assert.deepEqual(olderCaller.projectCatalog, {
      status: settlement === "resolve" ? "ready" : "failed",
      cached: true,
    });
    assert.equal(t.completed(), 1);
    assert.equal(t.router.isCloudProject("old-project"), false);
    assert.equal(t.router.isCloudProject("new-project"), true);
    assert.equal(t.router.isCloudConversation("old-conversation"), false);
    assert.equal(t.router.isCloudConversation("new-conversation"), true);
    assert.equal(
      [...t.timers.values()].some((timer) => timer.ms >= 15_000),
      false,
    );
    client.snapshot = async () => {
      throw Error("synthetic new read offline");
    };
    const cached = await t.router.merge(localB);
    assert.deepEqual(
      cached.projects.map((project) => project.id),
      ["window-b-local-project", "new-project"],
    );
    assert.deepEqual(cached.projectCatalog, { status: "failed", cached: true });
  });

test("claim recovery cannot remove the next account's same-id claim or release further old claims after reset", async () => {
  const release = deferred<unknown>(),
    started = deferred<void>();
  const calls: string[] = [],
    removed: string[] = [];
  let ledger = ["same-id", "old-second"];
  const t = snapshotRace(
    {
      snapshot: async () => ({ snapshot: ownerSnapshot("a") }),
      call: async (_method, args) => {
        calls.push(String(args?.[0]));
        started.resolve();
        return release.promise;
      },
    },
    {
      list: () => ledger,
      add() {},
      remove: (id) => {
        removed.push(id);
        ledger = ledger.filter((value) => value !== id);
      },
    },
  );
  const local = snapshot({});
  const oldRead = t.router.merge(local);
  await started.promise;
  t.router.reset();
  t.setClient({
    call: async () => undefined,
    snapshot: async () => ({ snapshot: ownerSnapshot("b") }),
  });
  ledger = ["same-id", "b-other"];
  release.resolve(undefined);
  assert.equal(await oldRead, local);
  assert.deepEqual(calls, ["same-id"]);
  assert.deepEqual(removed, []);
  assert.deepEqual(ledger, ["same-id", "b-other"]);
  assert.equal(t.router.isCloudProject("a-project"), false);
});

test("a queued old retry callback cannot clear or fire the next account's retry timer", async () => {
  const failed: CloudCalls = {
    call: async () => undefined,
    snapshot: async () => {
      throw Error("synthetic offline");
    },
  };
  const t = snapshotRace(failed);
  await t.router.merge(snapshot({}));
  const retryA = t.timer(15_000);
  t.router.reset();
  t.setClient({ ...failed });
  await t.router.merge(snapshot({}));
  const retryB = t.timer(15_000);
  t.fire(retryA); // It may already have entered the task queue when cleared.
  assert.equal(t.timers.get(retryB)?.active, true);
  assert.deepEqual(t.events, []);
  t.fire(retryB);
  assert.deepEqual(t.events, [{ type: "resync" }]);
});

test("a stored file is read locally first, then in the cloud", async () => {
  const t = setup();
  const read = t.router.route("readGeneratedFile", async () => null);
  assert.equal(await read("digest"), "cloud:readGeneratedFile");
  const found = t.router.route("readGeneratedFile", async () => "local bytes");
  assert.equal(await found("digest"), "local bytes");
});

test("the cloud environment's GitHub connection goes to the service, and stays local without the cloud", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let online = true;
  const router = new CloudRouter({
    client: () =>
      online
        ? {
            call: async () => undefined,
            snapshot: async () => ({ snapshot: snapshot({}) }),
            json: async (path: string, init?: RequestInit) => {
              requests.push({ path, init });
              return {
                code: 0,
                data: { configured: true, connected: true, login: "octo" },
              };
            },
          }
        : undefined,
    push: () => {},
    attachmentBytes: async () => undefined,
  });
  const local = async () => {
    throw new Error("GitHub repositories work in Claudex on the web.");
  };
  const status = router.route("githubStatus", local);
  assert.deepEqual(await status(), {
    configured: true,
    connected: true,
    login: "octo",
  });
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/api/v1/claudex/web/github"],
  );
  await assert.rejects(
    router.route("githubConnect", local)(),
    /GitHub address/,
  );
  assert.equal(requests[1].path, "/api/v1/claudex/web/github/connect");
  assert.equal(requests[1].init?.method, "POST");
  online = false;
  await assert.rejects(status(), /work in Claudex on the web/);
});

test("a link a crash interrupted is released on the next snapshot; one that arrived is kept", async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const pending = new Set(["lost-task", "arrived-task"]);
  const client = {
    call: async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      return undefined;
    },
    snapshot: async () => ({ snapshot: snapshot({}) }),
  };
  const router = new CloudRouter({
    client: () => client,
    push: () => {},
    attachmentBytes: async () => undefined,
    claims: {
      list: () => [...pending],
      add: (id) => void pending.add(id),
      remove: (id) => void pending.delete(id),
    },
  });
  await router.merge(
    snapshot({
      conversations: [
        { ...conversation("arrived-task", "cowork"), linkedToComputer: true },
      ],
    }),
  );
  assert.deepEqual(calls, [
    { method: "releaseCoworkTask", args: ["lost-task"] },
  ]);
  assert.deepEqual([...pending], []);
  // A claim lasts only while the link runs.
  const link = router.route("linkCoworkTaskToComputer", async () => {
    assert.ok(pending.has("t"), "claimed before the import");
    return conversation("t", "cowork");
  });
  await link("t");
  assert.deepEqual([...pending], []);
});

test("a cloud Chat carries this computer's permission mode; Code doesn't", async () => {
  const t = setup(
    { conversations: [conversation("c-code", "code")] },
    { taskPermission: () => "bypass" },
  );
  await t.router.route("snapshot", async () => localSnapshot)();
  const send = t.router.route("send", t.local("send"));
  const input = { text: "hi", attachments: [], providerId: "p", model: "m" };
  await send({ ...input, mode: "chat" });
  await send({ ...input, mode: "code", conversationId: "c-code" });
  const sent = t.calls
    .filter((c) => c.method === "send")
    .map((c) => (c.args[0] as Record<string, unknown>).taskPermission);
  assert.deepEqual(sent, ["bypass", undefined]);
});
