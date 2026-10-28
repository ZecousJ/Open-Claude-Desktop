import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { Store } from "../../electron/store/store";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import type { AppContext } from "../../electron/app/app-context";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import { pageRoutineRuns } from "../../shared/routine-history-page";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import {
  nextRun,
  type Routine,
  type RoutineInput,
} from "../../shared/routines";
import { type RoutineRun } from "../../shared/routine-labels";

const now = Date.UTC(2026, 9, 17, 0);
const input = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "Synthetic task",
  prompt: "Synthetic instruction",
  mode: "cowork",
  providerId: "p",
  model: "Opus",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: now + 86_400_000,
  ...patch,
});
const runs = (count: number): RoutineRun[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `synthetic-run-${index}`,
    status: "completed",
    trigger: "manual",
    startedAt: now - index * 1000,
    conversationId: `synthetic-chat-${index}`,
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("real scheduler pages stored history with an opaque stable anchor and keeps the legacy array API", (t) => {
  const folder = fs.mkdtempSync("/tmp/claudex-r4-scheduled-store-");
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const options = {
    isBusy: () => false,
    now: () => now,
    run: async () => {
      throw new Error("unused");
    },
  };
  const initial = new Scheduler(folder, options);
  const task = initial.save(input());
  const stored = runs(251);
  fs.writeFileSync(
    path.join(folder, "routine-runs.json"),
    JSON.stringify({ [task.id]: stored }),
  );
  const scheduler = new Scheduler(folder, options);
  const first = scheduler.runsPage(task.id);
  assert.equal(first.runs.length, 100);
  assert.ok(first.nextCursor?.startsWith("r1."));
  assert.ok(!first.nextCursor!.includes("synthetic-run"));
  const second = scheduler.runsPage(task.id, { cursor: first.nextCursor });
  const third = scheduler.runsPage(task.id, { cursor: second.nextCursor });
  assert.deepEqual([...first.runs, ...second.runs, ...third.runs], stored);
  assert.equal(third.nextCursor, undefined);
  assert.equal(scheduler.runs(task.id).length, 251);
  assert.deepEqual(
    pageRoutineRuns(task.id, [{ ...stored[0], id: "new-run" }, ...stored], {
      cursor: first.nextCursor,
    }).runs,
    second.runs,
  );
  assert.throws(
    () => scheduler.runsPage(task.id, { cursor: "bad" }),
    /history page couldn’t be loaded/,
  );
  assert.throws(
    () => pageRoutineRuns("another-task", stored, { cursor: first.nextCursor }),
    /history page couldn’t be loaded/,
  );
  assert.throws(() => scheduler.runsPage(task.id, { limit: 101 }), /1 to 100/);
  assert.throws(
    () =>
      pageRoutineRuns(
        task.id,
        stored.filter((run) => run.id !== first.runs.at(-1)!.id),
        { cursor: first.nextCursor },
      ),
    /history changed/,
  );
  const changed = scheduler.runsPage(task.id, { limit: 1 });
  changed.runs[0].id = "caller mutation";
  assert.equal(
    scheduler.runsPage(task.id, { limit: 1 }).runs[0].id,
    stored[0].id,
  );
});

test("the same local and runner IPC handlers expose real paging and execution-side schedule previews", (t) => {
  const folder = fs.mkdtempSync("/tmp/claudex-r4-scheduled-ipc-");
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = new Store(folder);
  const scheduler = new Scheduler(path.join(folder, "scheduler"), {
    isBusy: () => false,
    now: () => now,
    run: async () => {
      throw new Error("unused");
    },
  });
  const task = scheduler.save(input());
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers((name, handler) => handlers.set(name, handler), {
    store,
    scheduler,
    allowedFolder() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
    onSettingsChanged: () => () => {},
  } as unknown as AppContext);
  assert.deepEqual(handlers.get("routineRunsPage")!(task.id, { limit: 1 }), {
    runs: [],
  });
  assert.throws(
    () => handlers.get("routineRunsPage")!(task.id, { limit: 0 }),
    /greater than|at least|>=1/,
  );
  const rule = { kind: "cron", expression: "0 9 * * 1-5" } as const;
  const result = handlers.get("routineSchedulePreview")!(rule);
  assert.deepEqual(result, {
    nextRunAt: nextRun(rule, now),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  assert.deepEqual(
    handlers.get("routineSchedulePreview")!({ kind: "manual" }),
    { nextRunAt: null, timeZone: result.timeZone },
  );
  assert.throws(
    () =>
      handlers.get("routineSchedulePreview")!({
        kind: "cron",
        expression: "*/5 * * * *",
      }),
    /at most once per hour/,
  );
  assert.throws(
    () =>
      scheduler.save(
        input({
          name: "Impossible cron",
          repeat: { kind: "cron", expression: "0 9 31 2 *" },
        }),
      ),
    /No upcoming run/,
  );
});

test("cloud paging, read receipts and previews use the selected execution endpoint and expire after reset", async () => {
  const calls: { name: string; args: unknown[] | undefined }[] = [];
  const late = deferred<unknown>();
  let delay = false;
  const task = {
    ...input(),
    id: "remote-task",
    createdAt: now,
    updatedAt: now,
  } as Routine;
  const client: CloudCalls = {
    call: async (name, args) => {
      calls.push({ name, args });
      if (delay) return late.promise;
      if (name === "listSchedules") return [task];
      if (name === "routineRunsPage")
        return pageRoutineRuns(task.id, runs(3), args?.[1] as never);
      if (name === "routineSchedulePreview")
        return { nextRunAt: now + 1000, timeZone: "UTC" };
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const cloud = new CloudRoutines(() => client);
  await cloud.route("listSchedules", async () => [])!();
  const page = cloud.route("routineRunsPage", async () => {
    throw new Error("wrong local endpoint");
  })!;
  const first = await page(task.id, { limit: 1 });
  assert.equal(first.runs[0].id, "synthetic-run-0");
  const second = await page(task.id, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.runs[0].id, "synthetic-run-1");
  assert.deepEqual(calls.at(-1)?.args, [
    task.id,
    { limit: 1, cursor: first.nextCursor },
  ]);
  await cloud.route("markRoutineRunRead", async () => {
    throw new Error("wrong local receipt");
  })!(task.id, first.runs[0].id);
  assert.equal(calls.at(-1)?.name, "markRoutineRunRead");
  const preview = cloud.route("routineSchedulePreview", async () => ({
    nextRunAt: now + 2000,
    timeZone: "Asia/Tokyo",
  }))!;
  const rule = { kind: "cron", expression: "0 9 * * *" };
  assert.equal((await preview(rule, "local")).timeZone, "Asia/Tokyo");
  assert.equal((await preview(rule, "remote")).timeZone, "UTC");
  delay = true;
  const old = preview(rule, "remote");
  const refused = assert.rejects(old, /Couldn’t connect/);
  cloud.reset();
  late.resolve({ nextRunAt: now, timeZone: "UTC" });
  await refused;
});

test("cross-source saves check fresh names and serialize colliding creations without losing display names", async () => {
  const local: Routine[] = [],
    remote: Routine[] = [];
  let nextId = 0;
  const client: CloudCalls = {
    call: async (name, args) => {
      if (name === "listSchedules") return remote;
      const fields = args?.[0] as RoutineInput;
      const task = {
        ...fields,
        name: fields.name.trim(),
        id: `remote-${++nextId}`,
      } as Routine;
      remote.push(task);
      return task;
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const cloud = new CloudRoutines(() => client);
  cloud.route("listSchedules", async () => local);
  const save = cloud.route("saveSchedule", async (fields: RoutineInput) => {
    const task = { ...fields, id: `local-${++nextId}` } as Routine;
    local.push(task);
    return task;
  })!;
  const first = save(input({ name: "  夸我  ", executionLocation: "remote" }));
  // Real Scheduler trims names; the synthetic remote mirrors that contract.
  const original = await first;
  assert.equal(original.name, "夸我");
  const sameName = input({ name: "Shared", executionLocation: "local" });
  const results = await Promise.allSettled([
    save(sameName),
    save({ ...sameName, executionLocation: "remote" }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.match(
    String(
      (
        results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ),
    /already exists/,
  );
  assert.equal(local.length + remote.length, 2);
});

test("automatic cwd access recovery checks the real folder and preserves the disabled task on failure", async (t) => {
  const root = fs.mkdtempSync("/tmp/claudex-r4-scheduled-recovery-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const scheduler = new Scheduler(path.join(root, "scheduler"), {
    isBusy: () => false,
    now: () => now,
    run: async () => {
      fs.rmdirSync(workspace);
      throw new Error("Synthetic workspace unavailable");
    },
  });
  const task = scheduler.save(
    input({ name: "Synthetic local Code", mode: "code", cwd: workspace }),
  );
  await assert.rejects(scheduler.runNow(task.id));
  const disabled = scheduler.list()[0];
  assert.equal(disabled.endedReason, "auto_disabled_repo_access");
  assert.equal(disabled.enabled, false);
  assert.throws(
    () => scheduler.save({ ...disabled, enabled: true }),
    /Restore access/,
  );
  assert.equal(scheduler.list()[0].enabled, false);
  fs.mkdirSync(workspace);
  const recovered = scheduler.save({ ...disabled, enabled: true });
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.endedReason, undefined);
  assert.equal(scheduler.runs(task.id)[0].status, "failed");
});

test("an account reset releases the new save queue and invalidates queued old-account names", async () => {
  const late = deferred<Routine>(),
    started = deferred<void>();
  const writes: string[] = [];
  const a: CloudCalls = {
    call: async (name) => {
      if (name === "listSchedules") return [];
      writes.push("A");
      started.resolve();
      return late.promise;
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const b: CloudCalls = {
    call: async (name, args) => {
      if (name === "listSchedules") return [];
      writes.push("B");
      return { ...(args?.[0] as RoutineInput), id: "B-task" };
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  let client = a;
  const cloud = new CloudRoutines(() => client);
  cloud.route("listSchedules", async () => []);
  const save = cloud.route("saveSchedule", async () => {
    throw new Error("wrong local endpoint");
  })!;
  const first = save(input({ name: "A first", executionLocation: "remote" }));
  const oldFirst = assert.rejects(first, /Couldn’t connect/);
  const second = save(input({ name: "A queued", executionLocation: "remote" }));
  const oldSecond = assert.rejects(second, /Couldn’t connect/);
  await started.promise;
  client = b;
  cloud.reset();
  assert.equal(
    (await save(input({ name: "B fresh", executionLocation: "remote" }))).id,
    "B-task",
  );
  late.resolve({ ...input({ name: "A first" }), id: "A-task" } as Routine);
  await Promise.all([oldFirst, oldSecond]);
  assert.deepEqual(writes, ["A", "B"]);
});

test("the complete fixture bridge keeps real page queries, previews and explicit recovery variants after all domains merge", async () => {
  const fixture = (extra = "") =>
    createFixtureDesktop(
      { history: "empty" },
      new URLSearchParams(
        `fonts=system&routines=some&cloud=cowork,code&${extra}`,
      ),
    );
  const api = fixture("routineHistory=pages");
  const first = await api.routineRunsPage("r-review");
  const second = await api.routineRunsPage("r-review", {
    cursor: first.nextCursor,
  });
  const third = await api.routineRunsPage("r-review", {
    cursor: second.nextCursor,
  });
  assert.deepEqual(
    [first.runs.length, second.runs.length, third.runs.length],
    [100, 100, 5],
  );
  assert.equal(
    new Set([...first.runs, ...second.runs, ...third.runs].map((run) => run.id))
      .size,
    205,
  );
  assert.equal((await api.routineRuns("r-review")).length, 205);
  const before = Date.now();
  const rule = { kind: "cron", expression: "0 9 * * 1-5" } as const;
  const preview = await api.routineSchedulePreview(rule, "remote");
  assert.ok(
    [nextRun(rule, before), nextRun(rule, Date.now())].includes(
      preview.nextRunAt ?? undefined,
    ),
  );
  assert.equal(
    preview.timeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  await assert.rejects(
    fixture("schedulePreview=error").routineSchedulePreview(rule),
    /Synthetic schedule preview unavailable/,
  );
  const missing = fixture("routineRecovery=missing");
  const disabled = (await missing.listSchedules()).find(
    (task) => task.id === "r-review",
  )!;
  assert.equal(disabled.endedReason, "auto_disabled_repo_access");
  assert.equal(
    (await missing.routineRunsPage(disabled.id)).runs[0].status,
    "failed",
  );
  await assert.rejects(
    missing.saveSchedule({ ...disabled, enabled: true }),
    /Restore access/,
  );
  assert.equal(
    (await missing.listSchedules()).find((task) => task.id === disabled.id)!
      .enabled,
    false,
  );
  const restored = fixture("routineRecovery=restored");
  const task = (await restored.listSchedules()).find(
    (task) => task.id === "r-review",
  )!;
  const recovered = await restored.saveSchedule({ ...task, enabled: true });
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.endedReason, undefined);
});
