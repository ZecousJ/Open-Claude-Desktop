import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Store } from "../electron/store/store";
import { Scheduler } from "../electron/routines/scheduler";
import { prepareRoutineInput } from "../electron/routines/routine-input";
import { registerLocalScheduleReads } from "../electron/official-ui/native/schedules";
import { validAllowed } from "../shared/routines";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-editor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let scheduleChanged: (() => void) | undefined;
  let now = 1700000000000;
  let runs = 0,
    identity = 1,
    owner = "owner",
    fail = false;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      runs++;
      throw Error("No execution allowed");
    },
    onChange: () => scheduleChanged?.(),
    now: () => now,
  });
  const task: any = {
    id: "owned",
    name: "Inert task",
    prompt: "Inert prompt",
    description: "Inert description",
    mode: "code",
    providerId: "configured",
    model: "model-a",
    cwd: root,
    frequency: "daily",
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 1700042400000,
    repeat: { kind: "daily", time: "09:00" },
    permission: "default",
  };
  // Seed a disabled synthetic existing task; never start scheduler or create through a runtime API.
  scheduler.schedules = [task];
  const calls: string[] = [],
    writes: any[] = [],
    handlers = new Map<string, Function>();
  const store = new Store(root);
  const settings = (store.settings = {
    ...store.settings,
    providers: [
      {
        id: "configured",
        name: "Inert provider",
        baseUrl: "http://127.0.0.1:1",
        protocol: "responses",
        model: "model-a",
        models: ["model-b"],
      },
    ],
  });
  const serviceContext: any = {
    store,
    scheduler,
    allowedFolder: (cwd: string) => {
      if (cwd !== root && cwd !== path.join(root, "allowed"))
        throw Error("Folder not authorized");
    },
  };
  const serviceSource = fs.readFileSync(
    "electron/ipc/collections-schedules.ts",
    "utf8",
  );
  const serviceAst = ts.createSourceFile(
    "service.ts",
    serviceSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set([
    '"saveSchedule"',
    '"deleteSchedule"',
    '"officialCodeRoutineSnapshot"',
    '"removeRoutineApproval"',
  ]);
  const handlerSources = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(serviceAst) === "handle" &&
      names.has(node.arguments[0]?.getText(serviceAst))
    ) {
      const name = JSON.parse(node.arguments[0].getText(serviceAst));
      handlerSources.set(name, node.arguments[1].getText(serviceAst));
    }
    ts.forEachChild(node, visit);
  };
  visit(serviceAst);
  assert.equal(handlerSources.size, names.size);
  const service = vm.runInNewContext(
    ts.transpileModule(
      "({" +
        [...handlerSources]
          .map(([name, source]) => `${name}: ${source}`)
          .join(",") +
        "});",
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    {
      ctx: serviceContext,
      id: { parse: (value: string) => value },
      validAllowed,
      Date,
      prepareRoutineInput,
      defaultModelChoice: (settings: any) => ({
        providerId: settings.providers[0].id,
        model: settings.providers[0].model,
      }),
      cleanRoutineTriggers: () => undefined,
      forgetTriggers: () => {},
    },
  );
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    isCurrent: () => true,
    settings: () => settings,
    localCall: async (method: string, ...args: any[]) => {
      calls.push(method);
      if (method === "officialCodeRoutinePolicy") return scheduler.allowed();
      if (method === "listSchedules") return scheduler.list();
      const handler = service[method];
      assert.equal(typeof handler, "function");
      if (method === "saveSchedule" && fail)
        throw Error("inert persistence failure");
      const result = await handler(...args);
      if (method === "saveSchedule") writes.push(structuredClone(args[0]));
      return result;
    },
    onEvent: (listener: (event: unknown) => void) => {
      scheduleChanged = () =>
        listener({ type: "schedules", schedules: scheduler.list() });
      return () => {
        scheduleChanged = undefined;
      };
    },
  };
  const events: unknown[][] = [];
  const dispose = registerLocalScheduleReads({
    ctx,
    on: (name: string, fn: Function) => handlers.set(name, fn),
    emit(...args: unknown[]) {
      events.push(args);
    },
  } as any);
  return {
    root,
    scheduler,
    task,
    calls,
    writes,
    handlers,
    ctx,
    events,
    dispose,
    setNow: (value: number) => {
      now = value;
    },
    run: (input: any) =>
      Promise.resolve().then(() =>
        handlers.get("CCDScheduledTasks.createScheduledTask")!(input),
      ),
    retire: () => identity++,
    switch: () => (owner = "other"),
    fail: () => (fail = true),
    runs: () => runs,
  };
}

const asset = path.join(
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ??
    ".restore/archive-extracted/claude-frontend-4.4212.0",
  "dist/assets/v1/c0fd2fda3-BszltR_Y.js",
);
function payload(root: string) {
  const source = fs.readFileSync(asset, "utf8");
  const match = source.match(
    /T\.createScheduledTask,\n              (\{[\s\S]*?\n              \}),\n              \{ existingIds/,
  );
  assert.ok(match);
  return vm.runInNewContext("(" + match[1] + ")", {
    se: (name: string) => name.toLowerCase().replaceAll(" ", "-"),
    y: "Synthetic local task",
    E: "No execution allowed",
    x: "Fixture",
    Je: "0 9 * * *",
    t: {
      cwd: root,
      model: "model-a",
      useWorktree: false,
      sourceBranch: undefined,
      permissionMode: undefined,
    },
  });
}
test("actual local form payload creates, lists, edits and reopens using original save handler and inert Scheduler", async (t) => {
  const f = fixture(t),
    input = payload(f.root);
  const created = await f.run(input);
  assert.match(created.id, /^[a-f0-9-]{36}$/);
  assert.notEqual(created.id, input.name);
  assert.equal(created.displayName, input.displayName);
  assert.equal(created.enabled, true);
  assert.equal(f.scheduler.list().length, 2);
  const saved = f.scheduler.list().find((x) => x.id === created.id)!;
  assert.equal(saved.permission, "default");
  assert.equal(saved.providerId, "configured");
  assert.equal(saved.cwd, f.root);
  assert.equal(saved.mode, "code");
  assert.ok(saved.nextRunAt > 1700000000000);
  const listed = await f.handlers.get(
    "CCDScheduledTasks.getAllScheduledTasks",
  )!();
  assert.equal(
    listed.find((x: any) => x.id === created.id).displayName,
    input.displayName,
  );
  await f.handlers.get("CCDScheduledTasks.updateScheduledTask")!({
    scheduledTaskId: created.id,
    description: "Edited fixture",
  });
  const reopened = new Scheduler(f.root, {
    isBusy: () => false,
    run: async () => {
      throw Error("forbidden");
    },
  });
  assert.equal(
    reopened.list().find((x) => x.id === created.id)?.description,
    "Edited fixture",
  );
  assert.equal(f.runs(), 0);
  await assert.rejects(f.run(input)); // existing service's duplicate display-name boundary
  assert.equal(f.scheduler.list().length, 2);
});
test("default model selection is explicit follows-default; duplicate provider model is not guessed", async (t) => {
  const f = fixture(t);
  const input = payload(f.root);
  delete input.model;
  await f.run(input);
  const saved = f.scheduler.list().find((x) => x.id !== "owned")!;
  assert.equal(saved.defaultModel, true);
  assert.equal(saved.model, "model-a");
  const g = fixture(t);
  g.ctx.settings().providers.push({ id: "other", model: "model-a" });
  await assert.rejects(g.run(payload(g.root)), /one configured provider/);
  assert.equal(g.writes.length, 0);
});
test("unsupported targets and invalid input do not save; native service keeps folder and policy guards", async (t) => {
  const f = fixture(t),
    input = payload(f.root);
  for (const change of [
    { id: "owned" },
    { scheduledTaskId: "owned" },
    { mode: "cowork" },
    { providerId: "other" },
    { place: { cwd: f.root } },
    { sourceBranch: "main" },
    { permissionMode: "dontAsk" },
    { permissionMode: null },
    { cronExpression: "nonsense" },
    { model: "unknown" },
    { cwd: "/not-authorized" },
  ])
    await assert.rejects(f.run({ ...input, ...change }));
  assert.equal(f.writes.length, 0);
  assert.equal(f.runs(), 0);
  assert.equal(
    f.handlers.has("CoworkScheduledTasks.createScheduledTask"),
    false,
  );
  (f.scheduler as any).options.policy = () => ({
    scheduledTasks: { enabled: false },
  });
  await assert.rejects(f.run(input), /aren’t turned on/);
  assert.equal(f.scheduler.list().length, 1);
  f.ctx.readOnly = true;
  await assert.rejects(f.run(input), /unavailable/);
});

test("original manual create persists worktree and plan settings without scheduling a time", async (t) => {
  const f = fixture(t);
  const created = await f.run({
    ...payload(f.root),
    cronExpression: undefined,
    useWorktree: true,
    sourceBranch: "main",
    permissionMode: "plan",
  });
  assert.equal(created.enabled, true);
  assert.equal(created.cronExpression, undefined);
  assert.equal(created.nextRunAt, undefined);
  assert.equal(created.useWorktree, true);
  assert.equal(created.sourceBranch, "main");
  assert.equal(created.permissionMode, "plan");
  const reopened = new Scheduler(f.root, {
    isBusy: () => false,
    run: async () => {
      throw Error("forbidden");
    },
    now: () => 1700000000000,
  });
  const stored = reopened.list().find((row) => row.id === created.id);
  assert.deepEqual(stored?.repeat, { kind: "manual" });
  assert.equal(stored?.sourceBranch, "main");
  assert.equal(stored?.codePermissionMode, "plan");
  assert.equal(f.runs(), 0);
});

test("Code schedule file, recorded skips, approval removal and deletion reflect the local scheduler", async (t) => {
  const f = fixture(t);
  const call = (operation: string, ...args: unknown[]) =>
    f.handlers.get(`CCDScheduledTasks.${operation}`)!(...args);
  assert.equal(call("setEventAckSupported"), true);
  assert.equal(call("setHostRunsSupported"), false);
  assert.equal(call("markListenerReady"), true);
  await call("getAllScheduledTasks");
  const created = await f.run({
    ...payload(f.root),
    prompt: "Keep the body.\n\n---\nMore instructions.",
    description: "Daily check\nfor regressions.",
  });
  assert.deepEqual(
    f.events.map(([, , event]) => (event as { type: string }).type),
    ["scheduled_task_created"],
  );
  assert.equal(
    await call("getScheduledTaskFileContent", created.id),
    `---\nname: ${created.id}\ndescription: Daily check for regressions.\n---\n\nKeep the body.\n\n---\nMore instructions.`,
  );
  assert.equal(await call("getScheduledTaskFileContent", "/etc/hosts"), null);
  assert.deepEqual(await call("getWatcherHistory", created.id), []);
  const saved = f.scheduler.list().find((row) => row.id === created.id)!;
  f.scheduler.allow(created.id, {
    kind: "command",
    tool: "Run command",
    pattern: "git status",
  });
  f.scheduler.allow(created.id, {
    kind: "command",
    tool: "Run command",
    pattern: "git diff",
  });
  f.setNow(saved.nextRunAt);
  f.scheduler.skip(saved, "busy");
  assert.deepEqual(
    f.events.map(([, , event]) => (event as { type: string }).type),
    [
      "scheduled_task_created",
      "scheduled_task_updated",
      "scheduled_task_updated",
      "scheduled_task_updated",
    ],
  );
  const [row] = (await call("getAllScheduledTasks")).filter(
    (row: { id: string }) => row.id === created.id,
  );
  assert.deepEqual(row.missedRuns, [
    {
      time: new Date(saved.nextRunAt).toISOString(),
      reason: "global_limit",
    },
  ]);
  assert.deepEqual(
    row.approvedPermissions.map(
      (entry: { ruleContent: string }) => entry.ruleContent,
    ),
    ["git status", "git diff"],
  );
  assert.equal(
    await call(
      "removeApprovedPermission",
      created.id,
      "Run command",
      "git status",
    ),
    true,
  );
  assert.deepEqual(
    f.scheduler.allowedFor(created.id).map((entry) => entry.pattern),
    ["git diff"],
  );
  assert.equal(
    await call(
      "removeApprovedPermission",
      created.id,
      "Run command",
      "git status",
    ),
    false,
  );
  assert.equal(
    await call("updateScheduledTaskStatus", created.id, "deleted", true),
    true,
  );
  assert.equal(
    await call("updateScheduledTaskStatus", created.id, "deleted"),
    false,
  );
  assert.equal(await call("getScheduledTaskFileContent", created.id), null);
  assert.deepEqual(
    f.scheduler.list().map((row) => row.id),
    ["owned"],
  );
  assert.equal(
    f.events.filter(
      ([, , event]) =>
        (event as { type: string }).type === "scheduled_task_deleted",
    ).length,
    1,
  );
  f.dispose();
  const afterDelete = f.events.length;
  f.scheduler.save({ ...f.scheduler.list()[0], name: "Changed after detach" });
  assert.equal(f.events.length, afterDelete);
  assert.equal(f.runs(), 0);
});
test("activation retirement across read and write is rejected, no automatic retry after uncertain save", async (t) => {
  const f = fixture(t),
    call = f.ctx.localCall;
  f.ctx.localCall = async (...args: any[]) => {
    const v = await call(...args);
    if (args[0] === "listSchedules") f.retire();
    return v;
  };
  await assert.rejects(f.run(payload(f.root)), /account changed/);
  assert.equal(f.writes.length, 0);
  const g = fixture(t),
    call2 = g.ctx.localCall;
  g.ctx.localCall = async (...args: any[]) => {
    const v = await call2(...args);
    if (args[0] === "saveSchedule") {
      g.retire();
      throw Error("uncertain result");
    }
    return v;
  };
  await assert.rejects(g.run(payload(g.root)), /uncertain result/);
  assert.equal(g.writes.length, 1);
  assert.equal(g.runs(), 0);
});
test("original pre-save workspace-trust cancellation never calls create", async (t) => {
  const f = fixture(t),
    source = fs.readFileSync(asset, "utf8");
  const fn = vm.runInNewContext(
    source.slice(
      source.indexOf("async function _n("),
      source.indexOf("\nfunction vn("),
    ) + ";_n",
  );
  await fn({
    cwd: f.root,
    ensureWorkspaceTrust: async () => false,
    doSave: () => f.run(payload(f.root)),
    setIsSaving: () => {},
    intl: { formatMessage: () => "" },
    addError: () => {},
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.runs(), 0);
});

test("concurrent local creates cannot overlap; error never retries or touches a replacement account", async (t) => {
  const f = fixture(t),
    call = f.ctx.localCall;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  f.ctx.localCall = async (...args: any[]) => {
    if (args[0] === "listSchedules") await wait;
    return call(...args);
  };
  const first = f.run(payload(f.root));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.run(payload(f.root)), /already in progress/);
  f.switch();
  release();
  await assert.rejects(first, /account changed/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.runs(), 0);
  const g = fixture(t);
  g.fail();
  await assert.rejects(g.run(payload(g.root)), /persistence failure/);
  assert.equal(g.calls.filter((x) => x === "saveSchedule").length, 1);
  assert.equal(g.writes.length, 0);
});
