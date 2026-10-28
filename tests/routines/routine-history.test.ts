import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { runDuration, routineRunLimit } from "../../shared/routine-labels";
import { proposeSchedule } from "../../shared/routine-proposals";
import type { Conversation, ScheduleInput, Turn } from "../../shared/types";
import { requestDraft } from "../../src/collections/routines/ScheduleConfirmCard";
import { defaultSettings } from "../../electron/store/store";

const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime();

function temporary(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-runs-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function task(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: "Daily review",
    prompt: "Review the selected project.",
    mode: "code",
    providerId: "p",
    model: "m",
    frequency: "hourly",
    nextRunAt: NOW,
    enabled: true,
    ...overrides,
  };
}
function conversation(
  id: string,
  status: Turn["status"],
  prompt = "Review the selected project.",
  extraTurns: Turn[] = [],
): Conversation {
  return {
    id,
    title: "Run",
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    turns: [
      {
        id: `${id}-turn`,
        prompt,
        attachments: [],
        items: [],
        status,
        createdAt: NOW,
      },
      ...extraTurns,
    ],
  };
}

test("each run is recorded with its trigger, conversation and result", async (t) => {
  const root = temporary(t);
  let clock = NOW;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => conversation("c1", "inProgress"),
    now: () => clock,
  });
  const saved = scheduler.save(task());
  await scheduler.runNow(saved.id);
  let [run] = scheduler.runs(saved.id);
  assert.equal(run.trigger, "manual");
  assert.equal(run.status, "running");
  assert.equal(run.conversationId, "c1");
  assert.equal(run.finishedAt, undefined);
  clock = NOW + 42_000;
  scheduler.observeConversation(conversation("c1", "completed"));
  [run] = scheduler.runs(saved.id);
  assert.equal(run.status, "completed");
  assert.equal(run.finishedAt, NOW + 42_000);
  assert.equal(runDuration(run), "42s");
  // History survives a restart.
  const again = new Scheduler(root, {
    isBusy: () => false,
    run: async () => conversation("c2", "completed"),
    now: () => clock,
  });
  assert.equal(again.runs(saved.id).length, 1);
  // Deleting the routine deletes its history.
  again.delete(saved.id);
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "routine-runs.json"), "utf8"),
  );
  assert.equal(raw[saved.id], undefined);
});

test("a failed dispatch is recorded as failed with its reason", async (t) => {
  const root = temporary(t);
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      throw new Error("No connection");
    },
    now: () => NOW,
  });
  const saved = scheduler.save(task());
  await assert.rejects(scheduler.runNow(saved.id), /No connection/);
  const [run] = scheduler.runs(saved.id);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "No connection");
});

test("a scheduled tick records a schedule trigger, and history is bounded", async (t) => {
  const root = temporary(t);
  let clock = NOW;
  let count = 0;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => conversation(`c${++count}`, "completed"),
    now: () => clock,
  });
  const saved = scheduler.save(task());
  await scheduler.tick();
  assert.equal(scheduler.runs(saved.id)[0].trigger, "schedule");
  for (let i = 0; i < routineRunLimit + 5; i++) {
    clock += 1000;
    await scheduler.runNow(saved.id);
  }
  const runs = scheduler.runs(saved.id);
  assert.equal(runs.length, routineRunLimit);
  assert.equal(runs[0].conversationId, `c${count}`);
  assert.equal(runs[0].status, "completed");
});

test("runs still going when the app closed read as interrupted", (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, "routine-runs.json"),
    JSON.stringify({
      r1: [{ id: "x", startedAt: NOW, status: "running", trigger: "manual" }],
      bad: "nope",
    }),
  );
  fs.writeFileSync(
    path.join(root, "schedules.json"),
    JSON.stringify([
      {
        ...task(),
        id: "r1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]),
  );
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => conversation("c", "completed"),
    now: () => NOW,
  });
  const [run] = scheduler.runs("r1");
  assert.equal(run.status, "interrupted");
  assert.match(run.error!, /app closed/);
  assert.throws(() => scheduler.runs("missing"), /no longer exists/);
});

test("a routine's conversation is unattended only while its run's turn works", async (t) => {
  const root = temporary(t);
  let seenDuringDispatch: boolean | undefined;
  let scheduler!: Scheduler;
  scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      // The engine reports the new conversation before `run` returns.
      scheduler.observeConversation(conversation("c1", "inProgress"));
      seenDuringDispatch = scheduler.isUnattended("c1");
      return conversation("c1", "inProgress");
    },
    now: () => NOW,
  });
  const saved = scheduler.save(task());
  assert.equal(scheduler.isUnattended("c1"), false);
  await scheduler.runNow(saved.id);
  assert.equal(seenDuringDispatch, true);
  assert.equal(scheduler.isUnattended("c1"), true);
  // A conversation the person started meanwhile is not the routine's.
  scheduler.observeConversation(conversation("mine", "inProgress", "Hello"));
  assert.equal(scheduler.isUnattended("mine"), false);
  scheduler.observeConversation(conversation("c1", "completed"));
  assert.equal(scheduler.isUnattended("c1"), false);
  // The person's next turn in the same conversation is attended.
  scheduler.observeConversation(
    conversation("c1", "completed", undefined, [
      {
        id: "next",
        prompt: "Thanks, now fix it",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: NOW + 1,
      },
    ]),
  );
  assert.equal(scheduler.isUnattended("c1"), false);
});

test("runningTask names the routine whose run works in a conversation, also while it is dispatched", async (t) => {
  const root = temporary(t);
  let duringDispatch: string | undefined;
  let scheduler!: Scheduler;
  scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      // An approval can arrive before `run` returns.
      scheduler.observeConversation(conversation("c1", "inProgress"));
      duringDispatch = scheduler.runningTask(
        conversation("c1", "inProgress"),
      )?.name;
      return conversation("c1", "inProgress");
    },
    now: () => NOW,
  });
  const saved = scheduler.save(task());
  await scheduler.runNow(saved.id);
  assert.equal(duringDispatch, "Daily review");
  assert.equal(
    scheduler.runningTask(conversation("c1", "inProgress"))?.id,
    saved.id,
  );
  assert.equal(
    scheduler.runningTask(conversation("mine", "inProgress", "Hello")),
    undefined,
  );
  scheduler.observeConversation(conversation("c1", "completed"));
  assert.equal(
    scheduler.runningTask(conversation("c1", "completed")),
    undefined,
    "a finished run no longer waits on anyone",
  );
});

test("/schedule descriptions become a proposed rule", () => {
  assert.deepEqual(proposeSchedule("every weekday at 9am check CI").repeat, {
    kind: "weekdays",
    time: "09:00",
  });
  assert.deepEqual(
    proposeSchedule("Every Monday at 2:30 pm summarize").repeat,
    {
      kind: "weekly",
      time: "14:30",
      day: 1,
    },
  );
  assert.deepEqual(
    proposeSchedule("On Tuesday and Thursday at 18:05 run tests").repeat,
    { kind: "custom", time: "18:05", days: [2, 4] },
  );
  assert.deepEqual(proposeSchedule("hourly look at the queue").repeat, {
    kind: "hourly",
    minute: 0,
  });
  assert.deepEqual(proposeSchedule("tidy the inbox").repeat, {
    kind: "daily",
    time: "09:00",
  });
  assert.deepEqual(proposeSchedule("at noon post a summary").repeat, {
    kind: "daily",
    time: "12:00",
  });
  const proposal = proposeSchedule("  review   yesterday's commits daily ");
  assert.equal(proposal.prompt, "review yesterday's commits daily");
  assert.equal(proposal.name, "Review yesterday's commits");
  assert.equal(
    proposeSchedule("every weekday at 9am review the open PRs and summarize")
      .name,
    "Review the open PRs and summarize",
  );
  assert.throws(() => proposeSchedule("   "), /Describe/);
});

test("the confirmation draft keeps the composer's folder and a known model", () => {
  const settings = structuredClone(defaultSettings);
  settings.providers[0].model = "gpt";
  const draft = requestDraft(
    {
      description: "every Friday at 5pm write release notes",
      cwd: "/tmp/project",
      providerId: "default",
      model: "gpt",
    },
    settings,
    NOW,
  );
  assert.equal(draft.kind, "weekly");
  assert.equal(draft.day, 5);
  assert.equal(draft.time, "17:00");
  assert.equal(draft.cwd, "/tmp/project");
  assert.deepEqual(draft.model, { providerId: "default", model: "gpt" });
  assert.equal(draft.mode, "code");
  const unknown = requestDraft(
    { description: "daily check", providerId: "gone", model: "x" },
    settings,
    NOW,
  );
  assert.deepEqual(unknown.model, { default: true });
});
