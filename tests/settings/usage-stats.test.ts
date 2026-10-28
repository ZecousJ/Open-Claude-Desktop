import test from "node:test";
import assert from "node:assert/strict";
import {
  breakdownFrom,
  overviewFrom,
  recordsFrom,
  usageStatsPaths,
  validRange,
} from "../../shared/usage-stats-api";
import {
  bars,
  bucketLabel,
  compact,
  cost,
  dayOf,
  duration,
  presetOf,
  presetRange,
} from "../../src/settings/usage-activity/format";
import { createUsageStatsMethods } from "../../src-web/bridge/usage-stats";

const stats = {
  total_api_keys: 4,
  active_api_keys: 3,
  total_requests: 10,
  today_requests: 2,
  total_input_tokens: 100,
  total_output_tokens: 20,
  total_cache_creation_tokens: 5,
  total_cache_read_tokens: 15,
  total_tokens: 140,
  today_tokens: 30,
  total_actual_cost: 1.5,
  total_cost: 2,
  today_actual_cost: 0.25,
  today_cost: 0.5,
  average_duration_ms: 1200,
  rpm: 1,
  tpm: 99,
  by_platform: [
    {
      platform: "grok",
      total_requests: 1,
      total_tokens: 5,
      total_actual_cost: 0.1,
    },
    {
      platform: "openai",
      total_requests: 9,
      total_tokens: 135,
      total_actual_cost: 1.4,
      today_requests: 2,
    },
  ],
};
const quotas = {
  platform_quotas: [
    {
      platform: "openai",
      daily_limit_usd: 10,
      daily_usage_usd: 2,
      daily_window_resets_at: "2026-09-30T12:00:00Z",
      weekly_limit_usd: null,
    },
    { platform: "grok", monthly_limit_usd: 0, monthly_usage_usd: 0 },
    { platform: "gemini", daily_limit_usd: 5, daily_usage_usd: 0 },
  ],
};

test("the dashboard stats and the platform limits read as one overview", () => {
  const o = overviewFrom(stats, quotas);
  assert.equal(o.totals.cacheTokens, 20);
  assert.equal(o.totals.todayStandardCost, 0.5);
  assert.deepEqual(
    o.providers.map((p) => p.platform),
    ["openai", "grok", "gemini"],
  );
  const openai = o.providers[0]!;
  assert.equal(openai.quota.length, 1);
  assert.equal(openai.quota[0]!.limit, 10);
  assert.equal(openai.quota[0]!.resetsAt, Date.parse("2026-09-30T12:00:00Z"));
  // Limit 0 is kept: the provider is turned off for the account.
  assert.equal(o.providers[1]!.quota[0]!.limit, 0);
  // A provider with limits and no use is still listed.
  assert.equal(o.providers[2]!.requests, 0);
});

test("a missing or odd answer reads as zeros, not a crash", () => {
  const o = overviewFrom(undefined, "nope");
  assert.equal(o.totals.requests, 0);
  assert.deepEqual(o.providers, []);
  assert.deepEqual(breakdownFrom(null, null), { trend: [], models: [] });
  assert.deepEqual(recordsFrom(undefined), {
    items: [],
    total: 0,
    page: 1,
    pages: 1,
  });
});

test("the trend, the models and the requests keep their fields", () => {
  const b = breakdownFrom(
    {
      trend: [
        {
          date: "2026-09-30",
          requests: 2,
          input_tokens: 5,
          output_tokens: 1,
          cache_read_tokens: 4,
          total_tokens: 10,
          actual_cost: 0.2,
          cost: 0.3,
        },
      ],
    },
    {
      models: [
        {
          model: "gpt-5.5",
          requests: 2,
          total_tokens: 10,
          actual_cost: 0.2,
          cost: 0.3,
        },
      ],
    },
  );
  assert.equal(b.trend[0]!.cacheTokens, 4);
  assert.equal(b.models[0]!.standardCost, 0.3);
  const page = recordsFrom({
    items: [
      {
        id: 7,
        model: "m",
        created_at: "2026-09-30T00:00:00Z",
        input_tokens: 1,
        actual_cost: 0.5,
        api_key: { name: "k" },
        stream: true,
        duration_ms: 90,
      },
      { id: "bad", model: "x" },
    ],
    total: 40,
    page: 2,
    pages: 4,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.keyName, "k");
  assert.equal(page.items[0]!.durationMs, 90);
  assert.equal(page.items[0]!.firstTokenMs, null);
  assert.deepEqual([page.total, page.page, page.pages], [40, 2, 4]);
});

test("ranges are checked and the addresses carry them", () => {
  assert.throws(() =>
    validRange({ start: "x", end: "2026-01-01", granularity: "day" }),
  );
  assert.throws(() =>
    validRange({ start: "2026-02-01", end: "2026-01-01", granularity: "day" }),
  );
  const r = validRange({
    start: "2026-01-01",
    end: "2026-01-02",
    granularity: "hour",
  });
  assert.equal(r.granularity, "hour");
  assert.match(
    usageStatsPaths.trend(r, "Asia/Shanghai"),
    /granularity=hour&timezone=Asia%2FShanghai/,
  );
  const records = usageStatsPaths.records(
    { page: 0, pageSize: 5000, model: "a b" },
    "UTC",
  );
  assert.match(records, /page=1&page_size=100/);
  assert.match(records, /model=a\+b/);
});

test("numbers, money and durations are short", () => {
  assert.equal(compact(950), "950");
  assert.equal(compact(12_345), "12.3K");
  assert.equal(compact(4_200_000), "4.2M");
  assert.equal(compact(2_500_000_000), "2.5B");
  assert.equal(cost(0.0421), "$0.0421");
  assert.equal(cost(12.3456), "$12.35");
  assert.equal(duration(850), "850 ms");
  assert.equal(duration(1240), "1.24 sec");
  assert.equal(duration(75_000), "1.3 min");
  assert.equal(duration(null), "—");
});

test("presets end today and are recognised again", () => {
  const now = new Date(2026, 8, 30, 15);
  assert.deepEqual(presetRange("today", now), {
    start: "2026-09-30",
    end: "2026-09-30",
    granularity: "hour",
  });
  assert.equal(presetRange("7", now).start, "2026-09-24");
  assert.equal(presetOf(presetRange("30", now), now), "30");
  assert.equal(
    presetOf({ ...presetRange("30", now), granularity: "hour" }, now),
    "custom",
  );
  assert.equal(dayOf(new Date(2026, 0, 5)), "2026-01-05");
});

test("bars stack against the tallest bucket", () => {
  const { bars: list, max } = bars([
    {
      date: "2026-09-29",
      requests: 1,
      inputTokens: 50,
      outputTokens: 25,
      cacheTokens: 25,
      tokens: 100,
      cost: 0,
      standardCost: 0,
    },
    {
      date: "2026-09-30",
      requests: 1,
      inputTokens: 25,
      outputTokens: 0,
      cacheTokens: 0,
      tokens: 25,
      cost: 0,
      standardCost: 0,
    },
  ]);
  assert.equal(max, 100);
  assert.deepEqual(list[0]!.heights, [50, 25, 25]);
  assert.deepEqual(list[1]!.heights, [25, 0, 0]);
  assert.deepEqual(bars([]).bars, []);
  assert.equal(bucketLabel("2026-09-30 14:00", "hour"), "14:00");
});

test("the web asks the service with the session and reads its answers", async () => {
  const seen: string[] = [];
  const methods = createUsageStatsMethods({
    json: async (path: string) => {
      seen.push(path);
      if (path.includes("platform-quotas")) throw new Error("no limits");
      if (path.includes("/dashboard/stats")) return { code: 0, data: stats };
      if (path.includes("/dashboard/trend"))
        return { code: 0, data: { trend: [] } };
      if (path.includes("/dashboard/models"))
        return { code: 0, data: { models: [] } };
      return { code: 0, data: { items: [], total: 0, page: 1, pages: 1 } };
    },
  } as never);
  const overview = (await methods.usageOverview!()) as ReturnType<
    typeof overviewFrom
  >;
  assert.equal(overview.totals.requests, 10);
  assert.ok(overview.providers.every((p) => p.quota.length === 0));
  await methods.usageBreakdown!({
    start: "2026-09-01",
    end: "2026-09-30",
    granularity: "day",
  });
  await methods.usageRecords!({ page: 1, pageSize: 10 });
  assert.ok(
    seen.some((p) =>
      p.startsWith("/api/v1/usage/dashboard/trend?start_date=2026-09-01"),
    ),
  );
  await assert.rejects(() =>
    methods.usageBreakdown!({
      start: "nope",
      end: "2026-09-30",
      granularity: "day",
    }),
  );
});
