import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordedRoutineRunCount } from "../../shared/routine-run-count";
import { type Routine } from "../../shared/routines";
import { routineRunLimit, type RoutineRun } from "../../shared/routine-labels";
import type { Conversation, Approval } from "../../shared/types";
import { Scheduler } from "../../electron/routines/scheduler";
import {
  searchConversationState,
  searchRoutineRunLabel,
  searchScheduleLabel,
} from "../../src/collections/search/row-metadata";
import { setLocale } from "../../src/i18n";
const run = (
  id: string,
  status: RoutineRun["status"] = "completed",
): RoutineRun => ({ id, status, trigger: "manual", startedAt: 1 });

test("run metadata counts executions, keeps unknown legacy history unknown and labels retained lower bounds", async () => {
  assert.deepEqual(
    recordedRoutineRunCount([
      run("1"),
      run("2", "failed"),
      run("3", "skipped"),
    ]),
    { runCount: 2, runCountLimited: false },
  );
  assert.deepEqual(recordedRoutineRunCount([], 123), {});
  assert.deepEqual(recordedRoutineRunCount([]), {
    runCount: 0,
    runCountLimited: false,
  });
  assert.equal(
    recordedRoutineRunCount(
      Array.from({ length: routineRunLimit }, (_, i) => run(String(i))),
    ).runCountLimited,
    true,
  );
  await setLocale("en-US");
  assert.equal(searchRoutineRunLabel({}), undefined);
  assert.equal(searchRoutineRunLabel({ runCount: -1 }), undefined);
  assert.equal(searchRoutineRunLabel({ runCount: 0 }), undefined);
  assert.equal(searchRoutineRunLabel({ runCount: 1 }), "1 run");
  assert.equal(searchRoutineRunLabel({ runCount: 2 }), "2 runs");
  assert.equal(
    searchRoutineRunLabel({ runCount: 1000, runCountLimited: true }),
    "1000+ runs",
  );
});

test("actual scheduler list and restart expose recorded counts without persisting display fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-r6-run-count-"));
  let now = Date.UTC(2026, 9, 17, 2);
  const c = {
    id: "run-session",
    title: "Fixture",
    mode: "code",
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    turns: [
      {
        id: "t",
        prompt: "Fixture",
        items: [],
        attachments: [],
        createdAt: now,
        status: "completed",
      },
    ],
  } as Conversation;
  const options = { isBusy: () => false, now: () => now, run: async () => c };
  try {
    const scheduler = new Scheduler(root, options);
    const task = scheduler.save({
      name: "Metadata fixture",
      prompt: "Synthetic execution",
      mode: "code",
      providerId: "fixture",
      model: "fixture",
      frequency: "daily",
      nextRunAt: now + 86400000,
      enabled: false,
      cwd: root,
    });
    assert.equal(task.runCount, 0);
    assert.equal(scheduler.list()[0].runCount, 0);
    await scheduler.runNow(task.id);
    now += 1000;
    assert.equal(scheduler.list()[0].runCount, 1);
    const restored = new Scheduler(root, options);
    assert.equal(restored.list()[0].runCount, 1);
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, "schedules.json"), "utf8"),
    )[0];
    assert.equal(Object.hasOwn(saved, "runCount"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status uses live requests before running state; recurrence and counts translate independently", async () => {
  await setLocale("en-US");
  const c = { id: "c", turns: [{ status: "inProgress" }] } as Conversation;
  assert.deepEqual(searchConversationState(c), {
    kind: "running",
    label: "Running",
  });
  assert.equal(searchConversationState({ ...c, turns: [] }), undefined);
  assert.deepEqual(
    searchConversationState(c, [{ conversationId: "c" } as Approval]),
    { kind: "awaiting", label: "Awaiting input" },
  );
  const task = {
    repeat: { kind: "daily", time: "09:59" },
    frequency: "daily",
    nextRunAt: Date.now(),
  } as Routine;
  assert.match(searchScheduleLabel(task), /^Daily at /);
  try {
    await setLocale("zh-CN");
    assert.match(searchScheduleLabel(task), /^每天 /);
    assert.equal(searchRoutineRunLabel({ runCount: 2 }), "2 次运行");
  } finally {
    await setLocale("en-US");
  }
});

test("the 16px Enter glyph overrides the web result icon rule at the actual selector scope", async () => {
  const { default: postcss } = await import("postcss");
  const sheet = postcss.parse(
    fs.readFileSync("src/collections/search/search.css", "utf8"),
  );
  const values: Record<string, string> = {};
  sheet.walkRules(
    ':root[data-surface="web"] .search-row > .search-row-enter',
    (rule) => {
      rule.walkDecls((d) => {
        values[d.prop] = d.value;
      });
    },
  );
  assert.equal(values.width, "16px");
  assert.equal(values.height, "16px");
  assert.equal(values.color, "var(--text-muted)");
});
