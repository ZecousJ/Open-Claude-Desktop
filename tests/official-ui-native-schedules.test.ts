import test from "node:test";
import assert from "node:assert/strict";
import { validRepeat } from "../shared/routines";
import {
  localScheduledTaskRows,
  registerLocalScheduleReads,
} from "../electron/official-ui/native/schedules";
const task = {
  id: "routine-one",
  name: "Morning report",
  prompt: "Summarize notes",
  mode: "cowork",
  model: "configured",
  frequency: "daily",
  enabled: true,
  createdAt: 1,
  nextRunAt: 1700000000000,
  repeat: { kind: "daily", time: "09:15" },
};

test("native schedule reads preserve actual host-local rules and split Code/Cowork", () => {
  const rows = localScheduledTaskRows(
    [task, { ...task, id: "code", mode: "code" }],
    "cowork",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, task.id);
  assert.equal(rows[0].displayName, task.name);
  assert.equal(rows[0].cronExpression, "15 9 * * *");
  assert.equal(rows[0].nextRunAt, new Date(task.nextRunAt).toISOString());
  assert.equal(rows[0].filePath, "");
  assert.equal("permissionMode" in rows[0], false);
  assert.equal("boundDeviceUuid" in rows[0], false);
  assert.equal(
    localScheduledTaskRows([{ ...task, enabled: false }], "cowork")[0]
      .nextRunAt,
    undefined,
  );
});
test("repeat rules keep once, custom days, weekly/monthly and cron semantics", () => {
  const map = (repeat: unknown) =>
    localScheduledTaskRows([{ ...task, repeat }], "cowork")[0];
  assert.equal(map({ kind: "once", at: 1699999980000 }).fireAt, 1699999980000);
  assert.equal(map({ kind: "hourly", minute: 3 }).cronExpression, "3 * * * *");
  assert.equal(
    map({ kind: "weekly", day: 2, time: "14:03" }).cronExpression,
    "3 14 * * 2",
  );
  assert.equal(
    map({ kind: "monthly", dayOfMonth: 7, time: "14:03" }).cronExpression,
    "3 14 7 * *",
  );
  assert.equal(
    map({ kind: "weekdays", time: "14:03" }).cronExpression,
    "3 14 * * 1-5",
  );
  assert.equal(
    map({ kind: "custom", days: [5, 1], time: "14:03" }).cronExpression,
    "3 14 * * 1,5",
  );
  assert.equal(
    map({ kind: "cron", expression: "0 8 * * 1" }).cronExpression,
    "0 8 * * 1",
  );
});
test("unsupported remote/held/external/manual tasks fail rather than disappear or invent capabilities", () => {
  for (const extra of [
    { executionLocation: "remote" },
    { environment: { kind: "ssh", hostId: "h" } },
    { connectionHold: {} },
    { triggers: { api: { id: "x" } } },
    { triggers: { schedule: false } },
    { repeat: { kind: "manual" } },
  ])
    assert.throws(
      () => localScheduledTaskRows([{ ...task, ...extra }], "cowork"),
      /not supported/,
    );
});
test("malformed, duplicate, oversized and invalid-time source results are not empty success", () => {
  for (const data of [
    null,
    {},
    [{ ...task, nextRunAt: NaN }],
    [task, task],
    Array.from({ length: 501 }, (_, i) => ({ ...task, id: String(i) })),
    [{ ...task, repeat: { kind: "daily", time: "99:99" } }],
  ])
    assert.throws(() => localScheduledTaskRows(data, "cowork"));
  assert.throws(
    () =>
      localScheduledTaskRows(
        Array.from({ length: 20 }, (_, i) => ({
          ...task,
          id: String(i),
          prompt: "x".repeat(262144),
        })),
        "cowork",
      ),
    /too large/,
  );
});
function fixture() {
  let owner: string | undefined = "owner",
    activation = 1,
    current = true,
    readOnly = false;
  let load = async (): Promise<unknown> => [task];
  const calls: string[] = [];
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  registerLocalScheduleReads({
    ctx: {
      account: () => (owner ? { id: owner } : undefined),
      sessionIdentity: () => activation,
      isCurrent: () => current,
      get readOnly() {
        return readOnly;
      },
      localCall: async (name: string) => {
        calls.push(name);
        return load();
      },
    },
    emit() {},
    on: (name: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(name, fn),
  } as never);
  return {
    run: (...args: unknown[]) =>
      Promise.resolve().then(() =>
        handlers.get("CoworkScheduledTasks.getAllScheduledTasks")!(...args),
      ),
    calls,
    setLoad: (value: typeof load) => (load = value),
    switchOwner: () => (owner = "other"),
    activate: () => activation++,
    retire: () => (current = false),
    signOut: () => (owner = undefined),
    readonly: () => (readOnly = true),
  };
}
test("native reads use only local listSchedules and enforce no-arg/auth/host contracts", async () => {
  const f = fixture();
  assert.equal(((await f.run()) as unknown[]).length, 1);
  assert.deepEqual(f.calls, ["listSchedules"]);
  await assert.rejects(f.run("forged"), /no arguments/);
  f.signOut();
  await assert.rejects(f.run(), /Sign in/);
  assert.equal(f.calls.length, 1);
  const g = fixture();
  g.readonly();
  await assert.rejects(g.run(), /unavailable/);
  assert.equal(g.calls.length, 0);
});
test("late account/reactivation/retirement and source errors never return prior schedule prompts", async () => {
  for (const change of ["switchOwner", "activate", "retire"] as const) {
    const f = fixture();
    f.setLoad(async () => {
      f[change]();
      return [task];
    });
    await assert.rejects(f.run(), /account changed/);
  }
  const f = fixture();
  f.setLoad(async () => {
    throw Error("store unavailable");
  });
  await assert.rejects(f.run(), /store unavailable/);
});

function mutableFixture() {
  let owner = "owner",
    activation = 1;
  let rows: any[] = [
    {
      ...task,
      providerId: "provider",
      permission: "manual",
      alwaysAllowed: [{ kind: "tool", tool: "safe" }],
      browserGrant: { record: "unchanged" },
    },
  ];
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const events: unknown[][] = [];
  let afterRead = () => {},
    beforeSave = async () => {},
    result = (value: any) => value;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerLocalScheduleReads({
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => activation,
      localCall: async (name: string, ...args: unknown[]) => {
        calls.push({ name, args });
        if (name === "listSchedules") {
          const value = structuredClone(rows);
          afterRead();
          return value;
        }
        assert.equal(name, "saveSchedule");
        await beforeSave();
        const saved = result(structuredClone(args[0]));
        rows = [saved];
        return saved;
      },
    },
    emit(...args: unknown[]) {
      events.push(args);
    },
    on: (name: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(name, fn),
  } as never);
  return {
    calls,
    events,
    run: (name: string, ...args: unknown[]) =>
      Promise.resolve().then(() =>
        handlers.get(`CoworkScheduledTasks.${name}`)!(...args),
      ),
    switchOwner: () => (owner = "other"),
    activate: () => activation++,
    afterRead: (fn: () => void) => (afterRead = fn),
    beforeSave: (fn: () => Promise<void>) => (beforeSave = fn),
    result: (fn: typeof result) => (result = fn),
  };
}
test("status edits use policy-owning saveSchedule and preserve provider, approvals and browser grants", async () => {
  const f = mutableFixture();
  assert.equal(
    await f.run("updateScheduledTaskStatus", task.id, "disabled"),
    true,
  );
  const saved = f.calls.find((c) => c.name === "saveSchedule")!.args[0] as any;
  assert.equal(saved.enabled, false);
  assert.equal(saved.providerId, "provider");
  assert.equal(saved.permission, "manual");
  assert.deepEqual(saved.browserGrant, { record: "unchanged" });
  assert.equal(saved.alwaysAllowed.length, 1);
  assert.equal(
    await f.run("updateScheduledTaskStatus", task.id, "enabled", undefined),
    true,
  );
});
test("text and schedule edits preserve unrelated security fields and return confirmed actual task", async () => {
  const f = mutableFixture();
  const row = (await f.run("updateScheduledTask", {
    scheduledTaskId: task.id,
    displayName: "Changed",
    prompt: "New prompt",
    description: "purpose",
    cronExpression: "0 8 * * 1",
  })) as any;
  assert.equal(row.displayName, "Changed");
  assert.equal(row.prompt, "New prompt");
  assert.equal(row.cronExpression, "0 8 * * 1");
  const input = f.calls.find((c) => c.name === "saveSchedule")!.args[0] as any;
  assert.equal(input.permission, "manual");
  assert.equal(input.providerId, "provider");
});
test("unsupported fields, delete/run statuses, file removal and wrong target never dispatch save", async () => {
  const f = mutableFixture();
  for (const data of [
    { scheduledTaskId: task.id, model: "new" },
    { scheduledTaskId: task.id, permissionMode: "bypassPermissions" },
    { scheduledTaskId: task.id, userSelectedFolders: ["/tmp"] },
    { scheduledTaskId: task.id },
    {
      scheduledTaskId: task.id,
      cronExpression: "* * * * *",
      fireAt: 1700000000000,
    },
  ])
    await assert.rejects(f.run("updateScheduledTask", data));
  for (const args of [
    [task.id, "deleted"],
    [task.id, "run"],
    [task.id, "enabled", false],
    [task.id, "disabled", true],
  ])
    await assert.rejects(f.run("updateScheduledTaskStatus", ...args));
  await assert.rejects(
    f.run("updateScheduledTaskStatus", "other-id", "disabled"),
    /no longer exists/,
  );
  assert.equal(
    f.calls.some((c) => c.name === "saveSchedule"),
    false,
  );
});
test("account changes before write stop mutation; policy failures and unconfirmed results do not become success", async () => {
  for (const change of ["switchOwner", "activate"] as const) {
    const f = mutableFixture();
    f.afterRead(() => f[change]());
    await assert.rejects(
      f.run("updateScheduledTaskStatus", task.id, "enabled"),
      /account changed/,
    );
    assert.equal(
      f.calls.some((c) => c.name === "saveSchedule"),
      false,
    );
  }
  const failed = mutableFixture();
  failed.beforeSave(async () => {
    throw Error("policy refuses activation");
  });
  await assert.rejects(
    failed.run("updateScheduledTaskStatus", task.id, "enabled"),
    /policy refuses/,
  );
  const malformed = mutableFixture();
  malformed.result((value) => ({ ...value, enabled: true }));
  await assert.rejects(
    malformed.run("updateScheduledTaskStatus", task.id, "disabled"),
    /not confirmed/,
  );
  const dropped = mutableFixture();
  dropped.result((value) => ({ ...value, name: "lost edit" }));
  await assert.rejects(
    dropped.run("updateScheduledTask", {
      scheduledTaskId: task.id,
      displayName: "Expected",
    }),
    /not confirmed/,
  );
});
test("repeated mutation is refused while in flight and failure permits explicit retry", async () => {
  const f = mutableFixture();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  f.beforeSave(async () => {
    started();
    await hold;
  });
  const first = f.run("updateScheduledTaskStatus", task.id, "disabled");
  await ready;
  await assert.rejects(
    f.run("updateScheduledTaskStatus", task.id, "disabled"),
    /already in progress/,
  );
  release();
  await first;
  f.beforeSave(async () => {});
  assert.equal(
    await f.run("updateScheduledTaskStatus", task.id, "enabled"),
    true,
  );
});

test("confirmed mutations emit actual refresh events; retired writes do not emit or acknowledge", async () => {
  const f = mutableFixture();
  await f.run("updateScheduledTaskStatus", task.id, "disabled");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], "CoworkScheduledTasks");
  assert.equal(f.events[0][1], "onScheduledTaskEvent");
  assert.equal((f.events[0][2] as any).type, "scheduled_task_updated");
  assert.equal((f.events[0][2] as any).scheduledTask.enabled, false);
  const retired = mutableFixture();
  retired.beforeSave(async () => {
    retired.activate();
  });
  await assert.rejects(
    retired.run("updateScheduledTaskStatus", task.id, "disabled"),
    /account changed/,
  );
  assert.equal(retired.events.length, 0);
});

test("same-account reactivation retires old mutation lease without old finally unlocking the new request", async () => {
  const f = mutableFixture();
  let releaseOld!: () => void, releaseNew!: () => void;
  let startedOld!: () => void, startedNew!: () => void;
  const oldStarted = new Promise<void>((r) => (startedOld = r));
  const newStarted = new Promise<void>((r) => (startedNew = r));
  const oldHold = new Promise<void>((r) => (releaseOld = r));
  const newHold = new Promise<void>((r) => (releaseNew = r));
  let saves = 0;
  f.beforeSave(async () => {
    saves++;
    if (saves === 1) {
      startedOld();
      await oldHold;
    } else if (saves === 2) {
      startedNew();
      await newHold;
    } else assert.fail("third request must remain locked");
  });
  const old = assert.rejects(
    f.run("updateScheduledTaskStatus", task.id, "disabled"),
    /account changed/,
  );
  await oldStarted;
  f.activate();
  const replacement = f.run("updateScheduledTaskStatus", task.id, "enabled");
  await newStarted;
  releaseOld();
  await old;
  await assert.rejects(
    f.run("updateScheduledTaskStatus", task.id, "disabled"),
    /already in progress/,
  );
  assert.equal(saves, 2);
  assert.equal(f.events.length, 0);
  releaseNew();
  assert.equal(await replacement, true);
  assert.equal(f.events.length, 1);
});

test("one-shot edit confirms the same minute normalization used by real scheduler validation", async () => {
  const f = mutableFixture();
  f.result((value) => ({ ...value, repeat: validRepeat(value.repeat) }));
  const row = (await f.run("updateScheduledTask", {
    scheduledTaskId: task.id,
    fireAt: 1900000000123,
  })) as any;
  assert.equal(row.fireAt, Math.floor(1900000000123 / 60000) * 60000);
  assert.equal(f.events.length, 1);
});

test("text edit normalization follows scheduler trim rules instead of reporting false failure", async () => {
  const f = mutableFixture();
  f.result((value) => ({
    ...value,
    name: value.name.trim(),
    prompt: value.prompt.trim(),
    description: value.description.trim(),
  }));
  const row = (await f.run("updateScheduledTask", {
    scheduledTaskId: task.id,
    displayName: "  Title  ",
    prompt: "  Instructions  ",
    description: "  Note  ",
  })) as any;
  assert.equal(row.displayName, "Title");
  assert.equal(row.prompt, "Instructions");
  assert.equal(row.description, "Note");
  await assert.rejects(
    f.run("updateScheduledTask", {
      scheduledTaskId: task.id,
      displayName: "   ",
    }),
  );
  await assert.rejects(
    f.run("updateScheduledTask", {
      scheduledTaskId: task.id,
      description: "x".repeat(1001),
    }),
  );
});
