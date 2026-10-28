import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadOperatorLimits,
  parseRequestLimits,
  resolveRequestLimits,
  saveOperatorLimits,
} from "../../server/operator-limits";
import { RequestLimiter } from "../../server/request-limiter";
import { UsageLedger } from "../../electron/conversations/usage-ledger";
import {
  isDismissed,
  weeklyUsageStatus,
  weeklyWindow,
} from "../../electron/conversations/weekly-usage";
import {
  dismissWeeklyUsage,
  readWeeklyUsage,
} from "../../electron/conversations/weekly-usage-status";
import type { UsageRecord } from "../../shared/types";

const account = "00000000-0000-4000-8000-000000000001";
const hour = 3_600_000;

/** Runs `body` with the process in `zone`, restoring the previous zone afterwards. */
function inZone(zone: string, body: () => void) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claudex-weekly-"));
}
function record(at: number, tokens: number): UsageRecord {
  return {
    id: `r-${at}`,
    at,
    providerId: "fixture",
    model: "fixture-model",
    protocol: "responses",
    durationMs: 1,
    statusCode: 200,
    usageKnown: true,
    inputTokens: tokens - 1,
    outputTokens: 1,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

test("weekly policy fields default for old files and are validated", () => {
  const defaults = parseRequestLimits({ dailyTokenLimit: 5 });
  assert.equal(defaults.weeklyTokenLimit, null);
  assert.equal(defaults.weeklyWarnPercent, 80);
  assert.equal(defaults.weeklyResetDay, 1);
  assert.equal(defaults.weeklyResetHour, 17);
  assert.equal(defaults.moreUsageUrl, null);
  assert.deepEqual(
    parseRequestLimits({
      weeklyTokenLimit: 1_000_000,
      weeklyWarnPercent: 100,
      weeklyResetDay: 0,
      weeklyResetHour: 0,
      moreUsageUrl: "https://usage.example.com/plans?from=app",
    }),
    {
      ...defaults,
      dailyTokenLimit: null,
      weeklyTokenLimit: 1_000_000,
      weeklyWarnPercent: 100,
      weeklyResetDay: 0,
      weeklyResetHour: 0,
      moreUsageUrl: "https://usage.example.com/plans?from=app",
    },
  );
  for (const bad of [
    { weeklyTokenLimit: 0 },
    { weeklyTokenLimit: 1.5 },
    { weeklyWarnPercent: 0 },
    { weeklyWarnPercent: 101 },
    { weeklyWarnPercent: null },
    { weeklyResetDay: 7 },
    { weeklyResetDay: -1 },
    { weeklyResetHour: 24 },
    { moreUsageUrl: "http://usage.example.com" },
    { moreUsageUrl: "javascript:alert(1)" },
    { moreUsageUrl: "https://user:secret@usage.example.com" },
    { moreUsageUrl: "not a url" },
    { moreUsageUrl: 3 },
  ])
    assert.throws(() => parseRequestLimits(bad), /out of range/, bad as never);

  const root = temporaryRoot();
  try {
    // A limits.json written before the weekly fields existed.
    fs.mkdirSync(path.join(root, "backend"));
    fs.writeFileSync(
      path.join(root, "backend", "limits.json"),
      JSON.stringify({
        version: 1,
        defaults: { dailyTokenLimit: 5 },
        accounts: { [account]: { maxConcurrent: 2 } },
      }),
    );
    assert.deepEqual(resolveRequestLimits(root, account), {
      ...defaults,
      maxConcurrent: 2,
    });
    saveOperatorLimits(root, {
      ...loadOperatorLimits(root),
      defaults: { dailyTokenLimit: 5, weeklyTokenLimit: 100 },
    });
    assert.equal(resolveRequestLimits(root, account).weeklyTokenLimit, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operator CLI edits and shows the weekly policy", () => {
  const root = temporaryRoot();
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "server/operator-limits-cli.ts",
        "--data-dir",
        root,
        ...args,
      ],
      { encoding: "utf8" },
    );
  try {
    const defaults = cli(
      "--defaults",
      "--weekly-tokens",
      "5000000",
      "--warn-percent",
      "75",
      "--reset-day",
      "sunday",
      "--reset-hour",
      "9",
    );
    assert.equal(defaults.status, 0, defaults.stderr);
    const override = cli(
      "--account",
      account,
      "--reset-day",
      "mon",
      "--more-usage-url",
      "https://usage.example.com/",
    );
    assert.equal(override.status, 0, override.stderr);
    const shown = cli("--show", "--account", account);
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout), {
      ...parseRequestLimits({}),
      weeklyTokenLimit: 5_000_000,
      weeklyWarnPercent: 75,
      weeklyResetDay: 1,
      weeklyResetHour: 9,
      moreUsageUrl: "https://usage.example.com/",
    });
    for (const bad of [
      ["--more-usage-url", "http://usage.example.com/"],
      ["--warn-percent", "0"],
      ["--reset-day", "someday"],
      ["--reset-hour", "24"],
      ["--weekly-tokens", "-4"],
    ]) {
      const refused = cli("--defaults", ...bad);
      assert.notEqual(refused.status, 0, bad.join(" "));
    }
    assert.notEqual(cli("--show", "--weekly-tokens", "5").status, 0);
    assert.equal(
      cli("--account", account, "--more-usage-url", "none").status,
      0,
    );
    assert.equal(resolveRequestLimits(root, account).moreUsageUrl, null);
    const help = spawnSync(
      process.execPath,
      ["--import", "tsx", "server/operator-limits-cli.ts"],
      { encoding: "utf8" },
    );
    assert.match(help.stderr, /--weekly-tokens N\|unlimited/);
    assert.match(help.stderr, /--more-usage-url URL\|none/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the usage week resets at the configured local weekday and hour", () => {
  inZone("America/Los_Angeles", () => {
    // Thursday 2026-09-24 09:00 PDT.
    const thursday = new Date(2026, 8, 24, 9).getTime();
    assert.equal(thursday, Date.UTC(2026, 8, 24, 16));
    const week = weeklyWindow(thursday, 1, 17);
    assert.equal(week.start, Date.UTC(2026, 8, 22, 0)); // Mon 21st 17:00 PDT
    assert.equal(week.end, Date.UTC(2026, 8, 29, 0)); // Mon 28th 17:00 PDT
    // At the reset instant the new week has begun; a minute before, it has not.
    assert.equal(weeklyWindow(week.end, 1, 17).start, week.end);
    assert.equal(weeklyWindow(week.end - 60_000, 1, 17).end, week.end);
    // Monday before the reset hour still belongs to the previous week.
    const mondayMorning = new Date(2026, 8, 28, 8).getTime();
    assert.deepEqual(weeklyWindow(mondayMorning, 1, 17), week);
    // That week is 169 hours.
    const autumn = weeklyWindow(new Date(2026, 9, 30, 12).getTime(), 1, 17);
    assert.equal(autumn.start, Date.UTC(2026, 9, 27, 0));
    assert.equal(autumn.end, Date.UTC(2026, 10, 3, 1));
    assert.equal(autumn.end - autumn.start, 169 * hour);
    // Sunday midnight resets.
    const sunday = weeklyWindow(thursday, 0, 0);
    assert.equal(new Date(sunday.start).getDay(), 0);
    assert.equal(new Date(sunday.start).getHours(), 0);
    assert.equal(sunday.end - sunday.start, 7 * 24 * hour);
  });
  inZone("Asia/Shanghai", () => {
    const thursday = Date.UTC(2026, 8, 24, 16); // Friday 00:00 in Shanghai
    const week = weeklyWindow(thursday, 1, 17);
    assert.equal(week.start, Date.UTC(2026, 8, 21, 9));
    assert.equal(week.end, Date.UTC(2026, 8, 28, 9));
  });
  inZone("UTC", () => {
    const week = weeklyWindow(Date.UTC(2026, 8, 28, 17), 1, 17);
    assert.equal(week.start, Date.UTC(2026, 8, 28, 17));
  });
});

test("weekly status warns from the threshold, reports exceeded and honours dismissal", () => {
  const policy = {
    ...parseRequestLimits({}),
    weeklyTokenLimit: 1000,
    moreUsageUrl: "https://usage.example.com/",
  };
  const now = Date.UTC(2026, 8, 24, 12);
  assert.equal(
    weeklyUsageStatus({ ...policy, weeklyTokenLimit: null }, 5, now),
    null,
  );
  const quiet = weeklyUsageStatus(policy, 799, now)!;
  assert.equal(quiet.state, "ok");
  assert.equal(quiet.percent, 79);
  const warning = weeklyUsageStatus(policy, 850, now)!;
  assert.deepEqual(
    { ...warning, resetsAt: 0 },
    {
      used: 850,
      limit: 1000,
      percent: 85,
      warnPercent: 80,
      resetsAt: 0,
      moreUsageUrl: "https://usage.example.com/",
      state: "warning",
      dismissed: false,
    },
  );
  assert.equal(
    warning.resetsAt,
    weeklyWindow(now, policy.weeklyResetDay, policy.weeklyResetHour).end,
  );
  const exceeded = weeklyUsageStatus(policy, 1400, now)!;
  assert.equal(exceeded.state, "exceeded");
  assert.equal(exceeded.percent, 100);
  // Dismissal lasts for the week, unless a warning later becomes exceeded.
  const week = warning.resetsAt;
  assert.equal(
    isDismissed({ resetsAt: week, exceeded: false }, week, "warning"),
    true,
  );
  assert.equal(
    isDismissed({ resetsAt: week, exceeded: false }, week, "exceeded"),
    false,
  );
  assert.equal(
    isDismissed({ resetsAt: week, exceeded: true }, week, "exceeded"),
    true,
  );
  assert.equal(
    isDismissed({ resetsAt: week - 1, exceeded: true }, week, "warning"),
    false,
  );
  assert.equal(isDismissed(undefined, week, "warning"), false);
});

test("weekly usage comes from this week's account usage log and dismissal is persisted per account", () => {
  const root = temporaryRoot();
  const other = "00000000-0000-4000-8000-000000000002";
  const profile = path.join(root, "profiles", account);
  const otherProfile = path.join(root, "profiles", other);
  try {
    saveOperatorLimits(root, {
      version: 1,
      defaults: { weeklyTokenLimit: 1000, weeklyResetHour: 0 },
      accounts: {},
    });
    const now = Date.now();
    const { start } = weeklyWindow(now, 1, 0);
    const ledger = new UsageLedger(profile);
    ledger.record(record(start - 1, 500)); // previous week
    ledger.record(record(start, 600));
    ledger.record(record(Math.max(start, now - 1000), 250));
    new UsageLedger(otherProfile).record(record(start + 1, 900));
    const status = readWeeklyUsage(root, account, profile, now)!;
    assert.equal(status.used, 850);
    assert.equal(status.state, "warning");
    assert.equal(status.dismissed, false);
    assert.equal(readWeeklyUsage(root, other, otherProfile, now)!.used, 900);

    assert.equal(
      dismissWeeklyUsage(root, account, profile, now, "warning")!.dismissed,
      true,
    );
    assert.equal(readWeeklyUsage(root, account, profile, now)!.dismissed, true);
    assert.equal(
      readWeeklyUsage(root, other, otherProfile, now)!.dismissed,
      false,
    );
    // Crossing into exceeded shows the banner again.
    ledger.record(record(now, 200));
    const over = readWeeklyUsage(root, account, profile, now)!;
    assert.equal(over.state, "exceeded");
    assert.equal(over.dismissed, false);
    // Closing a warning that has meanwhile become exceeded keeps the exceeded banner.
    assert.equal(
      dismissWeeklyUsage(root, account, profile, now, "warning")!.dismissed,
      false,
    );
    assert.equal(
      readWeeklyUsage(root, account, profile, now)!.dismissed,
      false,
    );
    dismissWeeklyUsage(root, account, profile, now, "exceeded");
    assert.equal(readWeeklyUsage(root, account, profile, now)!.dismissed, true);
    // The next week starts undismissed and empty.
    const next = readWeeklyUsage(root, account, profile, over.resetsAt)!;
    assert.equal(next.used, 0);
    assert.equal(next.dismissed, false);
    // Removing the weekly limit removes the status.
    saveOperatorLimits(root, { version: 1, defaults: {}, accounts: {} });
    assert.equal(readWeeklyUsage(root, account, profile, now), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the request limiter stops at the weekly limit until the week resets", () => {
  inZone("UTC", () => {
    let now = Date.UTC(2026, 8, 24, 12); // Thursday
    const limiter = new RequestLimiter(
      parseRequestLimits({ weeklyTokenLimit: 10 }),
      { day: "2026-09-24", tokens: 0, weekTokens: 8 },
      () => now,
    );
    limiter.acquire()();
    limiter.recordUsage(now, 1, 1);
    assert.throws(() => limiter.acquire(), /weekly token limit/);
    // The daily reset does not lift a weekly limit.
    now += 24 * hour;
    assert.throws(() => limiter.acquire(), /weekly token limit/);
    // Usage from before the current week does not count after the reset.
    now = Date.UTC(2026, 8, 28, 17);
    limiter.recordUsage(now - 1, 50, 50);
    limiter.acquire()();
  });
});
