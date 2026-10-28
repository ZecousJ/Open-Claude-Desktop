import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { routineJitterSeconds } from "../../electron/routines/scheduler-support";
import { createHash } from "node:crypto";
import { nextWakeAt } from "../../shared/routines";
import { routineCompletionNotices } from "../../shared/routine-notices";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import type { AppContext } from "../../electron/app/app-context";
import { Store } from "../../electron/store/store";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import {
  nextRun,
  routinesOffMessage,
  validRepeat,
  type RoutineInput,
} from "../../shared/routines";
import {
  repeatLabel,
  repeatOf,
  routinePermission,
} from "../../shared/routine-labels";
import type { Conversation, Settings } from "../../shared/types";

// Friday 25 September 2026, 12:00 local time.
const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime();
const local = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 8, day, hours, minutes, 0).getTime();

function temporary(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-routines-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function routine(overrides: Partial<RoutineInput> = {}): RoutineInput {
  return {
    name: "daily-code-review",
    description: "Review yesterday's commits",
    prompt: "Look at the commits from the last 24 hours.",
    mode: "code",
    providerId: "test-provider",
    model: "test-model",
    frequency: "daily",
    nextRunAt: 0,
    enabled: true,
    repeat: { kind: "daily", time: "09:00" },
    ...overrides,
  };
}
function conversation(id = "run-1"): Conversation {
  return {
    id,
    title: "Routine",
    mode: "code",
    providerId: "test-provider",
    model: "test-model",
    cwd: os.tmpdir(),
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    turns: [
      {
        id: "turn-1",
        prompt: "Review",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: NOW,
      },
    ],
  };
}
const withRoutines = (
  scheduledTasks: ClientPolicy["scheduledTasks"],
  extra: Partial<ClientPolicy> = {},
): ClientPolicy => ({ ...openPolicy, scheduledTasks, ...extra });

test("jitter is stable, persisted and respected by both scheduler and runner wake time", async (context) => {
  const root = temporary(context);
  let now = NOW;
  let runs = 0;
  const options = {
    now: () => now,
    isBusy: () => false,
    run: async () => {
      runs++;
      return conversation();
    },
  };
  const scheduler = new Scheduler(root, options);
  const task = scheduler.save(
    routine({
      disableJitter: false,
      notifyOnCompletion: { push: false, email: false, slack: false },
    }),
  );
  const delay =
    createHash("sha256").update(task.id).digest().readUInt32BE(0) % 600;
  assert.equal(task.dispatchJitterSeconds, delay);
  assert.equal(nextWakeAt([task]), task.nextRunAt + delay * 1000);
  const reopened = new Scheduler(root, options);
  assert.equal(reopened.list()[0].dispatchJitterSeconds, delay);
  assert.deepEqual(
    reopened.list()[0].notifyOnCompletion,
    task.notifyOnCompletion,
  );
  now = task.nextRunAt + delay * 1000 - 1;
  await reopened.tick();
  assert.equal(runs, 0);
  now++;
  await reopened.tick();
  assert.equal(runs, 1);
  const exact = scheduler.save({ ...task, disableJitter: true });
  assert.equal(exact.dispatchJitterSeconds, 0);
  assert.equal(nextWakeAt([exact]), exact.nextRunAt);
  assert.equal(
    routineJitterSeconds(
      { ...task, repeat: { kind: "once", at: NOW + 1000 } },
      NOW,
    ),
    0,
  );
  assert.equal(
    routineJitterSeconds({ ...task, repeat: { kind: "manual" } }, NOW),
    0,
  );
  assert.equal(
    routineJitterSeconds(
      { ...task, repeat: { kind: "cron", expression: "0 * * * *" } },
      NOW,
    ),
    delay,
  );
});

test("manual starts bypass jitter and invalid settings are rejected", async (context) => {
  const scheduler = new Scheduler(temporary(context), {
    now: () => NOW,
    isBusy: () => false,
    run: async () => conversation(),
  });
  const task = scheduler.save(routine({ disableJitter: false }));
  assert.equal((await scheduler.runNow(task.id)).lastRunStatus, "completed");
  assert.throws(
    () => scheduler.save(routine({ disableJitter: "yes" as any })),
    /Invalid scheduled task/,
  );
  assert.throws(
    () =>
      scheduler.save(
        routine({
          notifyOnCompletion: {
            push: "yes" as any,
            email: false,
            slack: false,
          },
        }),
      ),
    /Invalid scheduled task/,
  );
  assert.deepEqual(
    scheduler.save(
      routine({
        name: "email-task",
        notifyOnCompletion: { push: false, email: true, slack: false },
      }),
    ).notifyOnCompletion,
    { push: false, email: true, slack: false },
  );
});

test("finish notifications obey each routine's preference and use its final answer", async (context) => {
  const scheduler = new Scheduler(temporary(context), {
    now: () => NOW,
    isBusy: () => false,
    run: async () => ({
      ...conversation(),
      turns: [{ ...conversation().turns[0], status: "inProgress" }],
    }),
  });
  const task = scheduler.save(
    routine({ notifyOnCompletion: { push: true, email: false, slack: false } }),
  );
  await scheduler.runNow(task.id);
  const before = scheduler.list();
  const done = conversation();
  done.turns[0].items.push({
    id: "answer",
    type: "agentMessage",
    text: "Two new commits.\nNo issues found.",
  });
  scheduler.observeConversation(done);
  const after = scheduler.list();
  assert.equal(after[0].lastRunSummary, "Two new commits. No issues found.");
  assert.equal(
    routineCompletionNotices(before, after)[0].body,
    "Two new commits. No issues found.",
  );
  assert.deepEqual(routineCompletionNotices(after, after), []);
  assert.deepEqual(
    routineCompletionNotices(before, [
      {
        ...after[0],
        notifyOnCompletion: { push: false, email: false, slack: false },
      },
    ]),
    [],
  );
});

test("each rule's next run keeps local time and skips days it does not run on", () => {
  assert.equal(nextRun({ kind: "manual" }, NOW), undefined);
  assert.equal(nextRun({ kind: "hourly", minute: 15 }, NOW), local(25, 12, 15));
  assert.equal(
    nextRun({ kind: "hourly", minute: 0 }, NOW),
    local(25, 13),
    "a slot exactly now is not the next one",
  );
  assert.equal(nextRun({ kind: "daily", time: "09:00" }, NOW), local(26, 9));
  assert.equal(
    nextRun({ kind: "daily", time: "18:30" }, NOW),
    local(25, 18, 30),
  );
  // Friday noon: the next weekday 09:00 is Monday.
  assert.equal(nextRun({ kind: "weekdays", time: "09:00" }, NOW), local(28, 9));
  assert.equal(
    nextRun({ kind: "weekly", time: "02:16", day: 2 }, NOW),
    local(29, 2, 16),
  );
  // Same weekday, time already passed: a week later.
  assert.equal(
    nextRun({ kind: "weekly", time: "11:00", day: 5 }, NOW),
    local(25 + 7, 11),
  );
  assert.equal(
    nextRun({ kind: "custom", time: "01:49", days: [2, 3, 4, 5, 6] }, NOW),
    local(26, 1, 49),
  );
});

test("rules read as the original's schedule lines", () => {
  assert.equal(repeatLabel({ kind: "manual" }), "Manual");
  assert.equal(repeatLabel({ kind: "hourly", minute: 5 }), "Hourly at :05");
  assert.equal(
    repeatLabel({ kind: "weekdays", time: "20:18" }),
    "Weekdays at 8:18 PM",
  );
  assert.equal(
    repeatLabel({ kind: "daily", time: "19:47" }),
    "Daily at 7:47 PM",
  );
  assert.equal(
    repeatLabel({ kind: "weekly", time: "02:16", day: 2 }),
    "Every Tuesday at 2:16 AM",
  );
  assert.equal(
    repeatLabel({ kind: "custom", time: "01:49", days: [2, 3, 4, 5, 6] }),
    "At 01:49 AM, Tuesday through Saturday",
  );
  assert.equal(
    repeatLabel({ kind: "custom", time: "12:00", days: [1, 3, 5] }),
    "At 12:00 PM, Monday, Wednesday and Friday",
  );
  assert.equal(
    repeatLabel({ kind: "custom", time: "09:00", days: [1, 2, 3, 4, 5] }),
    "Weekdays at 9:00 AM",
  );
});

test("rules from the window are checked and a task saved before routines keeps its anchor", () => {
  assert.throws(() => validRepeat({ kind: "daily", time: "25:00" }), /time/);
  assert.throws(() => validRepeat({ kind: "hourly", minute: 60 }), /minute/);
  assert.throws(
    () => validRepeat({ kind: "custom", time: "09:00", days: [] }),
    /day/,
  );
  assert.throws(() => validRepeat({ kind: "yearly" }), /when/);
  assert.deepEqual(
    validRepeat({ kind: "custom", time: "09:00", days: [5, 1, 5] }),
    { kind: "custom", time: "09:00", days: [1, 5] },
  );
  const anchor = local(22, 7, 30); // a Tuesday
  assert.deepEqual(repeatOf({ frequency: "weekly", nextRunAt: anchor }), {
    kind: "weekly",
    time: "07:30",
    day: 2,
  });
  assert.deepEqual(repeatOf({ frequency: "hourly", nextRunAt: anchor }), {
    kind: "hourly",
    minute: 30,
  });
});

test("a routine's next slot comes from its rule; manual routines only run when started", async (t) => {
  const root = temporary(t);
  let now = NOW;
  const runs: string[] = [];
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => now,
    run: async (task) => {
      runs.push(task.name);
      return conversation();
    },
  });
  const weekdays = scheduler.save(
    routine({ name: "weekdays", repeat: { kind: "weekdays", time: "09:00" } }),
  );
  assert.equal(weekdays.nextRunAt, local(28, 9));
  assert.equal(weekdays.frequency, "daily");
  assert.equal(weekdays.description, "Review yesterday's commits");
  const manual = scheduler.save(
    routine({ name: "manual", repeat: { kind: "manual" } }),
  );
  now = local(28, 9, 1);
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(runs, ["weekdays"]);
  assert.equal(scheduler.list()[0].nextRunAt, local(29, 9));
  now = local(40, 9);
  await scheduler.runNow(manual.id);
  assert.deepEqual(runs, ["weekdays", "manual"]);
  // An explicit empty description remains distinct from an absent value.
  const edited = scheduler.save({ ...weekdays, description: "" });
  assert.equal(edited.description, "");
});

test("the scheduler refuses a taken or reserved name, keeps a project link, and runs a cron schedule", (t) => {
  const root = temporary(t);
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    run: async () => conversation(),
  });
  const first = scheduler.save(routine({ name: "Standup", projectId: "p1" }));
  assert.equal(first.projectId, "p1");
  assert.throws(
    () => scheduler.save(routine({ name: "standup" })),
    /A routine named “standup” already exists\./,
  );
  assert.throws(
    () => scheduler.save(routine({ name: "new-local" })),
    /This name is reserved/,
  );
  // Editing keeps its own name; letting the project go clears the link.
  const unlinked = scheduler.save({ ...first, projectId: undefined });
  assert.equal(unlinked.projectId, undefined);
  assert.equal(scheduler.list()[0].projectId, undefined);
  const cron = scheduler.save(
    routine({
      name: "Weekly cron",
      repeat: { kind: "cron", expression: "30 8 * * 1" },
    }),
  );
  assert.equal(cron.nextRunAt, local(28, 8, 30));
  assert.equal(cron.frequency, "daily");
  assert.throws(
    () =>
      scheduler.save(
        routine({
          name: "Too often",
          repeat: { kind: "cron", expression: "*/10 * * * *" },
        }),
      ),
    /at most once per hour/,
  );
});

test("with routines turned off nothing starts or is added, and saved ones wait unchanged", async (t) => {
  const root = temporary(t);
  let policy = withRoutines({ enabled: true, maxTasks: null });
  let calls = 0;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    policy: () => policy,
    run: async () => {
      calls++;
      return conversation();
    },
  });
  const saved = scheduler.save(
    routine({ repeat: { kind: "hourly", minute: 30 } }),
  );
  policy = withRoutines({ enabled: false, maxTasks: null });
  const due = { ...scheduler.list()[0] };
  // Make it overdue the way a stored slot would be.
  (scheduler as any).schedules[0].nextRunAt = NOW - 60_000;
  await scheduler.tick();
  assert.equal(calls, 0);
  await assert.rejects(
    scheduler.runNow(saved.id),
    new RegExp(routinesOffMessage),
  );
  assert.throws(
    () => scheduler.save(routine({ name: "another" })),
    /aren’t turned on for your account/,
  );
  // The person can still edit, pause or delete what they have.
  assert.equal(scheduler.save({ ...due, enabled: false }).enabled, false);
  scheduler.save({ ...due, enabled: true });
  (scheduler as any).schedules[0].nextRunAt = NOW - 60_000;
  policy = withRoutines({ enabled: true, maxTasks: null });
  await scheduler.tick();
  assert.equal(calls, 1, "one run once the administrator turns them back on");
});

test("the administrator's limit stops new routines but not edits", (t) => {
  const root = temporary(t);
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    policy: () => withRoutines({ enabled: true, maxTasks: 2 }),
    run: async () => conversation(),
  });
  const first = scheduler.save(routine({ name: "one" }));
  scheduler.save(routine({ name: "two" }));
  assert.throws(
    () => scheduler.save(routine({ name: "three" })),
    /allows up to 2 routines/,
  );
  assert.equal(scheduler.save({ ...first, name: "renamed" }).name, "renamed");
});

test("Bypass for routines is the person's own setting, whatever the policy allows", async (t) => {
  const settings = {
    codeSandbox: "danger-full-access" as const,
    codePlanMode: false,
    autoAcceptEdits: false,
    bypassFolders: ["/work/repo"],
    allowBypassPermissions: true,
  };
  assert.equal(routinePermission(settings, "code", "/work/repo"), "bypass");
  // Not confirmed for this folder: Auto, as in a session started by hand.
  assert.equal(routinePermission(settings, "code", "/elsewhere"), "auto");
  assert.equal(
    routinePermission(
      { ...settings, allowBypassPermissions: false },
      "code",
      "/work/repo",
    ),
    "auto",
  );
  assert.equal(
    routinePermission({ ...settings, codeSandbox: "read-only" }, "code"),
    "manual",
  );
  assert.equal(routinePermission(settings, "cowork", "/work/repo"), undefined);
  // A policy that allows no other mode still lets the routine start.
  const root = temporary(t);
  let calls = 0;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    policy: () =>
      withRoutines({ enabled: true, maxTasks: null }, { permissionModes: [] }),
    run: async () => {
      calls++;
      return conversation();
    },
  });
  const saved = scheduler.save(routine({ cwd: "/work/repo" }));
  await scheduler.runNow(saved.id);
  assert.equal(calls, 1);
});

test("routines on Default follow the active connection's default model", (t) => {
  const root = temporary(t);
  const store = new Store(path.join(root, "profile"));
  const provider = store.settings.providers[0];
  store.settings.providers = [
    { ...provider, id: "p1", model: "model-a", models: ["model-a", "model-b"] },
    { ...provider, id: "p2", model: "model-c", models: ["model-c"] },
  ];
  store.settings.activeProviderId = "p1";
  const scheduler = new Scheduler(path.join(root, "schedules"), {
    isBusy: () => false,
    now: () => NOW,
    run: async () => conversation(),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  let settingsChanged: ((settings: Settings) => void) | undefined;
  const ctx = {
    store,
    scheduler,
    onAccountActivated() {},
    onAccountDeactivating() {},
    allowedFolder: () => {},
    onSettingsChanged: (cb: (settings: Settings) => void) => {
      settingsChanged = cb;
      return () => {};
    },
  } as unknown as AppContext;
  registerCollectionHandlers((name, fn) => handlers.set(name, fn), ctx);
  const saved = handlers.get("saveSchedule")!(
    routine({ providerId: "", model: "", defaultModel: true }),
  );
  assert.equal(saved.providerId, "p1");
  assert.equal(saved.model, "model-a");
  const pinned = handlers.get("saveSchedule")!(
    routine({ name: "pinned", providerId: "p1", model: "model-b" }),
  );
  assert.throws(
    () => handlers.get("saveSchedule")!(routine({ providerId: "gone" })),
    /existing model provider/,
  );
  store.settings.activeProviderId = "p2";
  settingsChanged!(store.settings);
  const [first, second] = scheduler.list();
  assert.equal(first.providerId, "p2");
  assert.equal(first.model, "model-c");
  assert.equal(second.id, pinned.id);
  assert.equal(second.model, "model-b", "a chosen model stays chosen");
});
