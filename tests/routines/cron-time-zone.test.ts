import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Scheduler } from "../../electron/routines/scheduler";
import { cronAsDays, cronProblem, nextCron } from "../../shared/cron";
import {
  nextRun,
  validRepeat,
  type RoutineRepeat,
} from "../../shared/routines";

test("the stored repeat keeps the named zone and runs on its calendar", () => {
  const expression = "CRON_TZ=Asia/Kolkata 15 9 * * 1";
  const repeat = validRepeat({ kind: "cron", expression });
  assert.deepEqual(repeat, { kind: "cron", expression });
  assert.equal(
    nextRun(repeat, Date.parse("2026-11-08T23:00:00Z")),
    Date.parse("2026-11-09T03:45:00Z"),
  );
  assert.equal(cronAsDays(expression), undefined);
});

test("both zone prefixes work and an unknown zone is rejected", () => {
  assert.equal(
    nextCron("TZ=Asia/Tokyo 0 8 * * *", Date.parse("2026-11-12T22:00:00Z")),
    Date.parse("2026-11-12T23:00:00Z"),
  );
  assert.equal(cronProblem("CRON_TZ=America/Unknown 0 9 * * *"), "unknownZone");
  assert.equal(cronProblem("CRON_TZ=UTC */5 * * * *"), "subHourly");
  assert.equal(cronProblem("CRON_TZ=UTC 0 9 * * MON"), "numericOnly");
});

test("a zoned cron skips a wall time missing at the spring transition", () => {
  assert.equal(
    nextCron(
      "CRON_TZ=America/New_York 30 2 * * *",
      Date.parse("2026-03-08T06:00:00Z"),
    ),
    Date.parse("2026-03-09T06:30:00Z"),
  );
});

test("a zoned cron finds repeated wall times in actual timestamp order", () => {
  const expression = "CRON_TZ=America/New_York 0 0-2 * * *";
  const next = (after: string) => nextCron(expression, Date.parse(after));
  assert.equal(
    next("2026-11-01T04:59:59Z"),
    Date.parse("2026-11-01T05:00:00Z"),
  );
  assert.equal(
    next("2026-11-01T05:00:00Z"),
    Date.parse("2026-11-01T06:00:00Z"),
  );
  assert.equal(
    next("2026-11-01T06:00:00Z"),
    Date.parse("2026-11-01T07:00:00Z"),
  );
});

test("the scheduler reloads the zone and advances the persisted next run", (t) => {
  const root = mkdtempSync(join(tmpdir(), "claudex-cron-zone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-11-01T04:30:00Z");
  const options = {
    now: () => now,
    isBusy: () => false,
    run: async () => {
      throw new Error("Unexpected test dispatch");
    },
  };
  const repeat: RoutineRepeat = {
    kind: "cron",
    expression: "CRON_TZ=America/New_York 0 1 * * *",
  };
  const task = new Scheduler(root, options).save({
    name: "zoned-review",
    prompt: "Review the open pull requests.",
    mode: "code",
    providerId: "test-provider",
    model: "test-model",
    frequency: "daily",
    nextRunAt: 0,
    enabled: true,
    repeat,
  });
  assert.equal(task.nextRunAt, Date.parse("2026-11-01T05:00:00Z"));

  now = Date.parse("2026-11-01T05:30:00Z");
  const scheduler = new Scheduler(root, options);
  const [reloaded] = scheduler.list();
  assert.equal(reloaded.id, task.id);
  assert.deepEqual(reloaded.repeat, repeat);
  assert.equal(reloaded.nextRunAt, Date.parse("2026-11-01T06:00:00Z"));
  assert.equal(scheduler.runs(task.id)[0].status, "skipped");
});

test("cron without a zone still follows the computer's calendar", () => {
  const exact = new Date(2026, 10, 13, 9, 0).getTime();
  assert.equal(nextCron("0 9 * * *", exact - 1), exact);
  assert.equal(
    nextCron("0 9 * * *", exact),
    new Date(2026, 10, 14, 9, 0).getTime(),
  );
});
