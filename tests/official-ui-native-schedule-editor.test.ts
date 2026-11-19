import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Scheduler } from "../electron/routines/scheduler";
import { prepareRoutineInput } from "../electron/routines/routine-input";
import { registerLocalScheduleReads } from "../electron/official-ui/native/schedules";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-editor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
    now: () => 1700000000000,
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
    nextRunAt: 1700042400000,
    repeat: { kind: "daily", time: "09:00" },
    permission: "default",
  };
  // Seed a disabled synthetic existing task; never start scheduler or create through a runtime API.
  scheduler.schedules = [task];
  const calls: string[] = [],
    writes: any[] = [],
    handlers = new Map<string, Function>();
  const settings = {
    providers: [{ id: "configured", model: "model-a", models: ["model-b"] }],
  };
  const serviceContext: any = {
    store: { settings, projects: [] },
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
  let handlerSource = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(serviceAst) === "handle" &&
      node.arguments[0]?.getText(serviceAst) === '"saveSchedule"'
    )
      handlerSource = node.arguments[1].getText(serviceAst);
    ts.forEachChild(node, visit);
  };
  visit(serviceAst);
  assert.ok(handlerSource);
  const service = vm.runInNewContext(
    ts.transpileModule("const handler=" + handlerSource + ";handler;", {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      ctx: serviceContext,
      prepareRoutineInput,
      defaultModelChoice: () => ({
        providerId: "configured",
        model: "model-a",
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
    localCall: async (method: string, input: any) => {
      calls.push(method);
      if (method === "officialCodeRoutinePolicy") return scheduler.allowed();
      if (
        method === "listSchedules" ||
        method === "officialCodeRoutineSnapshot"
      )
        return scheduler.list();
      assert.equal(method, "saveSchedule");
      if (fail) throw Error("inert persistence failure");
      const result = service(input);
      writes.push(structuredClone(input));
      return result;
    },
  };
  registerLocalScheduleReads({
    ctx,
    on: (name: string, fn: Function) => handlers.set(name, fn),
    emit() {},
  } as any);
  return {
    root,
    scheduler,
    task,
    calls,
    writes,
    handlers,
    ctx,
    run: (input: any) =>
      Promise.resolve().then(() =>
        handlers.get("CCDScheduledTasks.updateScheduledTask")!(input),
      ),
    retire: () => identity++,
    switch: () => (owner = "other"),
    fail: () => (fail = true),
    runs: () => runs,
  };
}
function originalPayload(task: any) {
  const source = fs.readFileSync(
    path.join(
      process.env.CLAUDEX_OFFICIAL_UI_SOURCE ??
        ".restore/archive-extracted/claude-frontend-4.4212.0",
      "dist/assets/v1/c0fd2fda3-BszltR_Y.js",
    ),
    "utf8",
  );
  const start = source.indexOf("function un("),
    end = source.indexOf("\nfunction dn(", start);
  const originalFolder = vm.runInNewContext(source.slice(start, end) + ";un");
  const match = source.match(
    /T\.updateScheduledTask\(\{([\s\S]*?)\n              \}\)/,
  );
  assert.ok(match);
  // Exact original payload expression; schedule/time helper output is fixed synthetic data.
  return vm.runInNewContext("({" + match[1] + "})", {
    h: task,
    y: task.displayName,
    v: task.displayName,
    E: task.prompt,
    x: task.description,
    cn: () => ({}),
    R: "daily",
    Je: "0 9 * * *",
    t: {
      ...originalFolder(null, task.cwd, undefined),
      model: task.model,
      useWorktree: false,
      sourceBranch: undefined,
      permissionMode: task.permissionMode,
    },
  });
}
test("original editor payload accepts existing model/folder and disabled worktree without any save or execution", async (t) => {
  const f = fixture(t);
  const rows = await f.handlers.get(
    "CCDScheduledTasks.getAllScheduledTasks",
  )!();
  assert.equal(rows[0].cwd, f.root);
  const value = await f.run(originalPayload(rows[0]));
  assert.equal(value.id, "owned");
  assert.deepEqual(f.calls, ["officialCodeRoutineSnapshot", "listSchedules"]);
  assert.equal(f.runs(), 0);
  assert.equal(f.writes.length, 0);
});
test("supported model/folder edits use original folder guard and real scheduler persistence, preserving permission/provider/mode", async (t) => {
  const f = fixture(t);
  await f.run({
    scheduledTaskId: "owned",
    model: "model-b",
    cwd: path.join(f.root, "allowed"),
    useWorktree: false,
  });
  const saved = f.scheduler.list()[0];
  assert.equal(saved.model, "model-b");
  assert.equal(saved.cwd, path.join(f.root, "allowed"));
  assert.equal(saved.permission, "default");
  assert.equal(saved.providerId, "configured");
  assert.equal(saved.mode, "code");
  assert.equal(saved.enabled, false);
  assert.equal(f.runs(), 0);
  const reopened = new Scheduler(f.root, {
    isBusy: () => false,
    run: async () => {
      throw Error("forbidden");
    },
  });
  assert.equal(reopened.list()[0].model, "model-b");
  await assert.rejects(
    f.run({ scheduledTaskId: "owned", cwd: "/not-authorized" }),
    /not authorized/,
  );
  assert.equal(f.scheduler.list()[0].cwd, saved.cwd);
});
test("unsupported capabilities, unknown models and foreign tasks reject without writes", async (t) => {
  const f = fixture(t);
  for (const patch of [
    { sourceBranch: "main" },
    { permissionMode: "dontAsk" },
    { permissionMode: null },
    { place: { cwd: f.root } },
    { model: "unconfigured" },
    { providerId: "other" },
    { mode: "cowork" },
  ])
    await assert.rejects(f.run({ scheduledTaskId: "owned", ...patch }));
  await assert.rejects(
    f.run({ scheduledTaskId: "foreign", model: "model-b" }),
    /no longer exists/,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.runs(), 0);
});

test("Code editing switches between explicit and default models and clears worktree and permission choices", async (t) => {
  const f = fixture(t);
  const configured = await f.run({
    scheduledTaskId: "owned",
    model: "model-b",
    useWorktree: true,
    sourceBranch: "main",
    permissionMode: "acceptEdits",
  });
  assert.equal(configured.model, "model-b");
  assert.equal(configured.useWorktree, true);
  assert.equal(configured.sourceBranch, "main");
  assert.equal(configured.permissionMode, "acceptEdits");

  const inherited = await f.run({
    scheduledTaskId: "owned",
    model: undefined,
    useWorktree: false,
    sourceBranch: undefined,
    permissionMode: undefined,
    cronExpression: undefined,
  });
  assert.equal(inherited.model, undefined);
  assert.equal(inherited.permissionMode, undefined);
  assert.equal(inherited.cronExpression, undefined);
  assert.equal(inherited.nextRunAt, undefined);
  assert.equal(inherited.useWorktree, undefined);
  assert.equal(inherited.sourceBranch, undefined);
  const stored = f.scheduler.list()[0];
  assert.equal(stored.model, "model-a");
  assert.equal(stored.defaultModel, true);
  assert.equal(stored.codePermissionMode, "inherit");
  assert.deepEqual(stored.repeat, { kind: "manual" });

  const scheduled = await f.run({
    scheduledTaskId: "owned",
    model: "model-b",
    permissionMode: "bypassPermissions",
    cronExpression: "0 12 * * *",
  });
  assert.equal(scheduled.enabled, true);
  assert.equal(scheduled.permissionMode, "bypassPermissions");
  assert.equal(scheduled.model, "model-b");
  assert.equal(f.scheduler.list()[0].defaultModel, undefined);
  assert.equal(f.runs(), 0);
});
test("read retirement and persistence failure do not write a replacement account or claim success", async (t) => {
  const f = fixture(t);
  const call = f.ctx.localCall;
  f.ctx.localCall = async (...args: any[]) => {
    const result = await call(...args);
    if (args[0] === "listSchedules") f.retire();
    return result;
  };
  await assert.rejects(
    f.run({ scheduledTaskId: "owned", model: "model-b" }),
    /account changed/,
  );
  assert.equal(f.writes.length, 0);
  const g = fixture(t);
  g.fail();
  await assert.rejects(
    g.run({ scheduledTaskId: "owned", model: "model-b" }),
    /persistence failure/,
  );
  assert.equal(g.scheduler.list()[0].model, "model-a");
  assert.equal(g.runs(), 0);
});
