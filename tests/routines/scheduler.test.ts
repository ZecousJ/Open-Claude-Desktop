import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { nextOccurrence } from "../../electron/routines/scheduler-support";
import type {
  Conversation,
  Schedule,
  ScheduleInput,
  Turn,
} from "../../shared/types";

const HOUR = 60 * 60_000;
const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime();
function temporary(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-scheduler-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function task(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: "Daily review",
    prompt: "Review the selected project.",
    mode: "code",
    providerId: "test-provider",
    model: "test-model",
    frequency: "hourly",
    nextRunAt: NOW,
    enabled: true,
    ...overrides,
  };
}
function conversation(
  id = "conversation-1",
  status: Turn["status"] = "completed",
  error?: string,
): Conversation {
  return {
    id,
    title: "Scheduled review",
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
        status,
        error,
        createdAt: NOW,
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("connection holds persist, skip scheduled dispatch, and recover with Run now without pausing the schedule", async (context) => {
  const root = temporary(context);
  let runs = 0;
  const options = {
    isBusy: () => false,
    now: () => NOW + HOUR * 3,
    run: async () => {
      runs++;
      return conversation();
    },
  };
  let scheduler = new Scheduler(root, options);
  const saved = scheduler.save(task());
  const hold = { service: "notion", url: "https://mcp.notion.com/sign-in" };
  scheduler.holdForConnection(saved.id, hold);
  assert.equal(scheduler.list()[0].enabled, true);
  scheduler = new Scheduler(root, options);
  assert.deepEqual(scheduler.list()[0].connectionHold, hold);
  await scheduler.tick();
  assert.equal(runs, 0);
  scheduler.save({ ...scheduler.list()[0], name: "Edited while held" });
  assert.deepEqual(scheduler.list()[0].connectionHold, hold);
  await scheduler.runNow(saved.id);
  assert.equal(runs, 1);
  assert.equal(scheduler.list()[0].connectionHold, undefined);
  assert.equal(scheduler.list()[0].enabled, true);
});

test("computer access holds due Cowork tasks without consuming their scheduled time", async (t) => {
  let access = false;
  let runs = 0;
  const scheduler = new Scheduler(temporary(t), {
    isBusy: () => false,
    computerAccess: () => access,
    now: () => NOW,
    run: async () => {
      runs++;
      return conversation();
    },
  });
  const saved = scheduler.save(task({ mode: "cowork" }));
  await scheduler.tick();
  assert.equal(runs, 0);
  assert.equal(scheduler.list()[0].nextRunAt, saved.nextRunAt);
  access = true;
  await scheduler.tick();
  assert.equal(runs, 1);
});

test("CRUD validates inputs, preserves IDs and persists without mutating caller data", (t) => {
  const root = temporary(t);
  const options = {
    isBusy: () => false,
    run: async () => conversation(),
    now: () => NOW,
  };
  const scheduler = new Scheduler(root, options);
  const created = scheduler.save(task());
  assert(created.id);
  assert.equal(created.createdAt, NOW);
  const updated = scheduler.save({
    ...created,
    name: "Updated review",
    enabled: false,
  });
  assert.equal(updated.id, created.id);
  updated.name = "Only a returned copy";
  assert.equal(scheduler.list()[0].name, "Updated review");
  const restarted = new Scheduler(root, options);
  assert.equal(restarted.list()[0].enabled, false);
  assert.throws(() => restarted.save(task({ prompt: "" })), /Instructions/);
  assert.throws(() => restarted.save(task({ nextRunAt: Number.NaN })), /valid/);
  assert.throws(
    () => restarted.save(task({ cwd: "relative/folder" })),
    /absolute/,
  );
  assert.throws(
    () => restarted.save(task({ id: "missing" })),
    /no longer exists/,
  );
  restarted.delete(created.id);
  assert.deepEqual(new Scheduler(root, options).list(), []);
});

test("duplicate ticks and concurrent manual calls cannot dispatch the same slot twice", async (t) => {
  const root = temporary(t);
  const done = deferred<Conversation>();
  let calls = 0;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      calls++;
      return done.promise;
    },
    now: () => NOW,
  });
  const saved = scheduler.save(task());
  const first = scheduler.tick();
  await scheduler.tick();
  await assert.rejects(scheduler.runNow(saved.id), /Another task/);
  assert.equal(calls, 1);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(root, "schedules.json"), "utf8"),
  )[0];
  assert.equal(persisted.nextRunAt, NOW + HOUR);
  assert.equal(persisted.lastRunStatus, "starting");
  done.resolve(conversation());
  await first;
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(scheduler.list()[0].lastRunStatus, "completed");
});

test("busy agent records a skipped due task and advances its slot", async (t) => {
  const root = temporary(t);
  let busy = true;
  let calls = 0;
  const scheduler = new Scheduler(root, {
    isBusy: () => busy,
    run: async () => {
      calls++;
      return conversation();
    },
    now: () => NOW,
  });
  const saved = scheduler.save(task());
  await scheduler.tick();
  assert.equal(calls, 0);
  assert.equal(scheduler.list()[0].nextRunAt, NOW + HOUR);
  assert.equal(scheduler.runs(saved.id)[0].skipReason, "busy");
  await assert.rejects(scheduler.runNow(saved.id), /Another task/);
  busy = false;
  await scheduler.tick();
  assert.equal(calls, 0);
  await scheduler.runNow(saved.id);
  assert.equal(calls, 1);
});

test("missed occurrences collapse into one run and are not replayed after restart", async (t) => {
  const root = temporary(t);
  let calls = 0;
  const options = {
    isBusy: () => false,
    run: async () => {
      calls++;
      return conversation();
    },
    now: () => NOW,
  };
  const scheduler = new Scheduler(root, options);
  scheduler.save(task({ nextRunAt: NOW - 10 * HOUR }));
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(scheduler.list()[0].nextRunAt, NOW + HOUR);
  await new Scheduler(root, options).tick();
  assert.equal(calls, 1);
});

test("restart after reservation marks interrupted state and does not repeat the reserved occurrence", async (t) => {
  const root = temporary(t);
  const done = deferred<Conversation>();
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => done.promise,
    now: () => NOW,
  });
  scheduler.save(task());
  const pending = scheduler.tick();
  let restartedCalls = 0;
  const restarted = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      restartedCalls++;
      return conversation();
    },
    now: () => NOW,
  });
  assert.equal(restarted.list()[0].lastRunStatus, "interrupted");
  assert.match(restarted.list()[0].lastError!, /app closed/);
  await restarted.tick();
  assert.equal(restartedCalls, 0);
  done.resolve(conversation());
  await pending;
});

test("dispatch errors are persisted and the same failed slot is not automatically retried", async (t) => {
  const root = temporary(t);
  let calls = 0;
  const options = {
    isBusy: () => false,
    run: async (): Promise<Conversation> => {
      calls++;
      throw new Error("Provider is unavailable");
    },
    now: () => NOW,
  };
  const scheduler = new Scheduler(root, options);
  scheduler.save(task());
  await assert.rejects(scheduler.tick(), /Provider is unavailable/);
  const restarted = new Scheduler(root, options);
  const saved = restarted.list()[0];
  assert.equal(saved.lastError, "Provider is unavailable");
  assert.equal(saved.lastRunStatus, "failed");
  assert.equal(saved.lastRunAt, NOW);
  await restarted.tick();
  assert.equal(calls, 1);
});

test("asynchronous conversation failures are recorded after engine.send returns", async (t) => {
  const root = temporary(t);
  const options = {
    isBusy: () => false,
    run: async () => conversation("run-1", "inProgress"),
    now: () => NOW,
  };
  const scheduler = new Scheduler(root, options);
  scheduler.save(task());
  await scheduler.tick();
  assert.equal(scheduler.list()[0].conversationId, "run-1");
  assert.equal(scheduler.list()[0].lastRunStatus, "running");
  scheduler.observeConversation(
    conversation("unrelated", "failed", "Ignore me"),
  );
  assert.equal(scheduler.list()[0].lastError, undefined);
  scheduler.observeConversation(
    conversation("run-1", "failed", "The model stream failed"),
  );
  assert.equal(
    new Scheduler(root, options).list()[0].lastError,
    "The model stream failed",
  );
});

test("terminal events arriving before the send response are retained", async (t) => {
  const root = temporary(t);
  let scheduler: Scheduler;
  scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    run: async () => {
      scheduler.observeConversation(
        conversation("early", "failed", "Early failure"),
      );
      return conversation("early", "inProgress");
    },
  });
  scheduler.save(task());
  await scheduler.tick();
  assert.equal(scheduler.list()[0].lastRunStatus, "failed");
  assert.equal(scheduler.list()[0].lastError, "Early failure");
});

test("manual run works for a paused task and preserves an upcoming scheduled time", async (t) => {
  const root = temporary(t);
  let calls = 0;
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    run: async () => {
      calls++;
      return conversation();
    },
  });
  const saved = scheduler.save(task({ enabled: false, nextRunAt: NOW + HOUR }));
  await scheduler.tick();
  assert.equal(calls, 0);
  const result = await scheduler.runNow(saved.id);
  assert.equal(result.enabled, false);
  assert.equal(result.nextRunAt, NOW + HOUR);
  assert.equal(calls, 1);
});

test("editing or deleting a task during dispatch never replays or resurrects it", async (t) => {
  const root = temporary(t);
  const done = deferred<Conversation>();
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    run: async () => done.promise,
  });
  const saved = scheduler.save(task());
  const pending = scheduler.tick();
  scheduler.save({ ...saved, name: "Edited with a stale form" });
  assert.equal(scheduler.list()[0].nextRunAt, NOW + HOUR);
  scheduler.delete(saved.id);
  done.resolve(conversation());
  await pending;
  assert.deepEqual(scheduler.list(), []);
});

test("a tick starts only one due task and disabled tasks are skipped", async (t) => {
  const root = temporary(t);
  const names: string[] = [];
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => NOW,
    run: async (value: Schedule) => {
      names.push(value.name);
      return conversation(value.id);
    },
  });
  scheduler.save(
    task({ name: "Paused", enabled: false, nextRunAt: NOW - 2 * HOUR }),
  );
  scheduler.save(task({ name: "First", nextRunAt: NOW - HOUR }));
  scheduler.save(task({ name: "Second" }));
  await scheduler.tick();
  assert.deepEqual(names, ["First"]);
  await scheduler.tick();
  assert.deepEqual(names, ["First", "Second"]);
});

test("daily and weekly recurrence preserve local time while skipping missed dates", () => {
  const anchor = new Date(2026, 8, 1, 9, 30).getTime();
  const daily = new Date(
    nextOccurrence({ frequency: "daily", nextRunAt: anchor }, NOW),
  );
  assert.equal(daily.getDate(), 23);
  assert.equal(daily.getHours(), 9);
  assert.equal(daily.getMinutes(), 30);
  const weekly = new Date(
    nextOccurrence({ frequency: "weekly", nextRunAt: anchor }, NOW),
  );
  assert.equal(weekly.getDay(), new Date(anchor).getDay());
  assert.equal(weekly.getDate(), 29);
  assert.equal(weekly.getHours(), 9);
});

test("corrupt schedules are reported and preserved instead of being overwritten", (t) => {
  const root = temporary(t);
  const filename = path.join(root, "schedules.json");
  fs.writeFileSync(filename, "broken data");
  assert.throws(
    () =>
      new Scheduler(root, {
        isBusy: () => false,
        run: async () => conversation(),
      }),
    /have not been overwritten/,
  );
  assert.equal(fs.readFileSync(filename, "utf8"), "broken data");
});
