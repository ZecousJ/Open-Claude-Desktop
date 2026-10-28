import { routineSessionInput } from "../../electron/routines/routine-session";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { Engine } from "../../electron/engine/engine";
import { Scheduler } from "../../electron/routines/scheduler";
import { registerScheduledTaskSetup } from "../../electron/routines/scheduled-task-setup";
import { prepareRoutineInput } from "../../electron/routines/routine-input";
import { openPolicy } from "../../shared/client-policy";
import type { AppContext } from "../../electron/app/app-context";
import type { Conversation } from "../../shared/types";
import type { DynamicToolCall } from "../../electron/engine/engine-extensions";

function harness(t: { after(fn: () => unknown): unknown }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b30-setup-"));
  let store = new Store(root);
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.settings.providers[0].baseUrl = "http://127.0.0.1:1/v1";
  store.settings.providers[0].model = "model";
  store.settings.providers[0].models = ["model"];
  let policy = openPolicy;
  let sources: ("chat" | "code")[] = ["chat", "code"];
  const calls: { method: string; params: any }[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => policy;
  engine.ensure = async () => {};
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "setup-thread" } };
      if (method === "turn/start") return { turn: { id: "setup-turn" } };
      return {};
    },
  } as never;
  const schedulerOptions = {
    isBusy: () => false,
    onChange() {},
    run: async () => {
      assert.fail("test tasks must never execute");
      return {} as Conversation;
    },
    policy: () => policy,
  };
  let scheduler = new Scheduler(root, schedulerOptions);
  let activate = () => {},
    deactivate = () => {};
  const checked: { cwd?: string; environment?: unknown }[] = [];
  const ctx = {
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    engine,
    window: {},
    dataRoot: root,
    policy: () => policy,
    routineSources: () => sources,
    allowedFolder: (cwd?: string, environment?: unknown) => {
      checked.push({ cwd, environment });
    },
    onAccountActivated: (fn: () => void) => {
      activate = fn;
    },
    onAccountDeactivating: (fn: () => void) => {
      deactivate = fn;
    },
  } as unknown as AppContext;
  const setup = registerScheduledTaskSetup(ctx);
  activate();
  const request = {
    name: "Review notes",
    instructions: "Summarize my notes",
    source: "chat",
    runAt: Date.now() + 86400000,
  };
  const call = (c: Conversation, args: unknown = request) =>
    engine.extensions.handleDynamicTool({
      conversation: c,
      threadId: "setup-thread",
      turnId: "setup-turn",
      callId: "setup-call",
      namespace: null,
      tool: "create_scheduled_task",
      arguments: args,
      changed() {},
    } as DynamicToolCall);
  const ipc = new Map<string, (...args: any[]) => any>();
  registerConversationHandlers((name, handler) => ipc.set(name, handler), {
    get store() {
      return store;
    },
    engine,
    selectedAttachments: new Map(),
    allowedFolder: ctx.allowedFolder,
    noActive() {},
    replyFeedback: undefined as never,
  });
  const send = (intent?: any, mode: "chat" | "cowork" = "chat") =>
    ipc.get("send")!({
      text: "Help set up a task",
      attachments: [],
      mode,
      providerId: "default",
      model: "model",
      scheduledTaskSetup: intent,
    });
  return {
    root,
    get store() {
      return store;
    },
    ctx,
    engine,
    calls,
    setup,
    request,
    call,
    send,
    checked,
    restart() {
      scheduler = new Scheduler(root, schedulerOptions);
    },
    retire() {
      deactivate();
      store.flush();
      store = new Store(path.join(root, "other-account"));
    },
    setSources(value: typeof sources) {
      sources = value;
    },
    setPolicy(value: typeof policy) {
      policy = value;
    },
  };
}

test("real IPC → Engine setup advertises the tool, creates an actual scheduler file and returns a durable idempotent task link", async (t) => {
  const e = harness(t);
  assert.equal(e.setup.available(), true);
  const conversation = await e.send({ returnTo: "scheduled" });
  assert.deepEqual(conversation.scheduledTaskSetup, { returnTo: "scheduled" });
  const thread = e.calls.find((call) => call.method === "thread/start")!.params;
  assert.ok(
    thread.dynamicTools.some(
      (tool: any) => tool.name === "create_scheduled_task",
    ),
  );
  const created = await e.call(e.store.conversation(conversation.id));
  assert.equal(created?.success, true);
  const receipt = JSON.parse(
    (created!.contentItems[0] as { text: string }).text,
  );
  assert.equal(receipt.href, `/scheduled-task/${receipt.id}`);
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(e.root, "schedules.json"), "utf8"),
  );
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].setupConversationId, conversation.id);
  assert.equal(onDisk[0].prompt, e.request.instructions);
  assert.equal(
    e.store.conversation(conversation.id).scheduledTaskSetup?.createdTaskId,
    receipt.id,
  );
  e.restart();
  delete e.store.conversation(conversation.id).scheduledTaskSetup!
    .createdTaskId;
  const repeated = await e.call(e.store.conversation(conversation.id), {
    ...e.request,
    runAt: 1,
  });
  assert.equal(repeated?.success, true);
  assert.equal(
    JSON.parse((repeated!.contentItems[0] as { text: string }).text).id,
    receipt.id,
  );
  assert.equal(e.ctx.scheduler!.list().length, 1);
  assert.equal(
    e.store.conversation(conversation.id).scheduledTaskSetup!.createdTaskId,
    receipt.id,
  );
});

test("setup refuses unsupported sources, missing projects, invalid schedules and retired owners without creating tasks", async (t) => {
  const e = harness(t),
    c = await e.send({ returnTo: "scheduled" });
  e.setSources(["chat"]);
  assert.equal(
    (await e.call(e.store.conversation(c.id), { ...e.request, source: "code" }))
      ?.success,
    false,
  );
  assert.equal(
    (
      await e.call(e.store.conversation(c.id), {
        ...e.request,
        cron: "0 9 * * *",
      })
    )?.success,
    false,
  );
  e.store.conversation(c.id).scheduledTaskSetup!.projectId = "deleted";
  assert.equal((await e.call(e.store.conversation(c.id)))?.success, false);
  delete e.store.conversation(c.id).scheduledTaskSetup!.projectId;
  e.setPolicy({
    ...openPolicy,
    scheduledTasks: { ...openPolicy.scheduledTasks, enabled: false },
  });
  assert.equal((await e.call(e.store.conversation(c.id)))?.success, false);
  assert.equal(e.ctx.scheduler!.list().length, 0);
  e.retire();
  assert.equal(e.setup.available(), false);
});

test("ordinary Chat cannot acquire a scheduler tool by mentioning tasks in prose", async (t) => {
  const e = harness(t),
    c = await e.send();
  assert.equal(c.scheduledTaskSetup, undefined);
  const thread = e.calls.find((call) => call.method === "thread/start")!.params;
  assert.equal(
    thread.dynamicTools?.some(
      (tool: any) => tool.name === "create_scheduled_task",
    ) ?? false,
    false,
  );
  assert.equal((await e.call(e.store.conversation(c.id)))?.success, false);
  assert.equal(e.ctx.scheduler!.list().length, 0);
});

test("actual scheduler keeps an intentionally empty description and SSH execution identity; input checks owned cloud projects", (t) => {
  const e = harness(t);
  const task = e.ctx.scheduler!.save({
    name: "SSH task",
    prompt: "Read notes",
    mode: "code",
    providerId: "default",
    model: "model",
    frequency: "daily",
    nextRunAt: Date.now() + 86400000,
    enabled: false,
    description: "",
    environment: { kind: "ssh", hostId: "build" },
    cwd: "/srv/work",
  });
  e.restart();
  assert.equal(e.ctx.scheduler!.list()[0].description, "");
  assert.deepEqual(e.ctx.scheduler!.list()[0].environment, {
    kind: "ssh",
    hostId: "build",
  });
  assert.throws(
    () =>
      prepareRoutineInput(e.ctx, {
        ...task,
        environment: { kind: "space", spaceId: "someone-elses-space" },
      }),
    /cannot use/,
  );
  e.store.projects = [
    {
      id: "owned",
      name: "Owned",
      description: "",
      instructions: "",
      createdAt: 1,
      cwd: "/owned/repo",
      kind: "code",
      environment: { kind: "space", spaceId: "owned-space" },
    },
  ];
  const fields = prepareRoutineInput(e.ctx, {
    ...task,
    projectId: "owned",
    cwd: undefined,
    environment: undefined,
  });
  assert.equal(fields.cwd, "/owned/repo");
  assert.deepEqual(fields.environment, {
    kind: "space",
    spaceId: "owned-space",
  });
  assert.deepEqual(e.checked.at(-1), {
    cwd: "/owned/repo",
    environment: { kind: "space", spaceId: "owned-space" },
  });
});

test("changing the executing host clears same-path approvals instead of carrying them across machines", (t) => {
  const e = harness(t);
  const first = e.ctx.scheduler!.save({
    name: "Host scoped",
    prompt: "Read notes",
    mode: "code",
    providerId: "default",
    model: "model",
    frequency: "daily",
    nextRunAt: Date.now() + 86400000,
    enabled: false,
    cwd: "/same/repo",
    environment: { kind: "ssh", hostId: "one" },
    alwaysAllowed: [
      { kind: "command", tool: "Run command", pattern: "git status" },
    ],
  });
  const same = e.ctx.scheduler!.save({ ...first, name: "Renamed" });
  assert.equal(same.alwaysAllowed?.length, 1);
  const moved = e.ctx.scheduler!.save({
    ...same,
    environment: { kind: "ssh", hostId: "two" },
  });
  assert.equal(moved.alwaysAllowed, undefined);
});

test("the real scheduler dispatch retains the remote host/project and does not inspect its path as a local repository", async (t) => {
  const e = harness(t);
  let received: ReturnType<typeof routineSessionInput> | undefined;
  const scheduler = new Scheduler(path.join(e.root, "dispatch"), {
    isBusy: () => false,
    onChange() {},
    run: async (task) => {
      received = routineSessionInput(task);
      return {
        id: "remote-run",
        mode: "code",
        turns: [],
        createdAt: 1,
        updatedAt: 1,
      } as unknown as Conversation;
    },
  });
  const task = scheduler.save({
    name: "Remote owner",
    prompt: "Read notes",
    mode: "code",
    providerId: "default",
    model: "model",
    frequency: "daily",
    nextRunAt: Date.now() + 86400000,
    enabled: false,
    cwd: "/this-path-only-exists-on-the-host",
    projectId: "owned-project",
    environment: { kind: "ssh", hostId: "build" },
  });
  await scheduler.runNow(task.id);
  assert.equal(received?.projectId, "owned-project");
  assert.deepEqual(received?.environment, { kind: "ssh", hostId: "build" });
  assert.equal(received?.cwd, task.cwd);
  assert.notEqual(scheduler.list()[0].endedReason, "auto_disabled_repo_access");
});

test("the actual merged Chat execution kind carries setup through IPC and creates its real task", async (t) => {
  const e = harness(t),
    conversation = await e.send({ returnTo: "scheduled" }, "cowork");
  assert.equal(conversation.mode, "cowork");
  assert.deepEqual(conversation.scheduledTaskSetup, { returnTo: "scheduled" });
  assert.equal(
    (await e.call(e.store.conversation(conversation.id)))?.success,
    true,
  );
  assert.equal(e.ctx.scheduler!.list().length, 1);
});
