/**
 * Settings → Usage → Activity: `activity=1` gives the account's totals, two
 * providers with limits, a month of use and a few requests; `activity=empty`
 * an account that has used nothing. Without it the page shows only the plan.
 */
import type {
  UsageBreakdown,
  UsageOverview,
  UsageRecord,
  UsageRecordQuery,
  UsageRange,
} from "../../../shared/usage-stats-api";
import type { FixtureDomain } from "./index";

const day = 24 * 60 * 60 * 1000;

const overview: UsageOverview = {
  totals: {
    apiKeys: 4,
    activeApiKeys: 3,
    requests: 18_432,
    todayRequests: 212,
    inputTokens: 88_400_000,
    outputTokens: 9_100_000,
    cacheTokens: 610_000_000,
    tokens: 707_500_000,
    todayInputTokens: 1_250_000,
    todayOutputTokens: 180_000,
    todayCacheTokens: 9_400_000,
    todayTokens: 10_830_000,
    cost: 412.3184,
    todayCost: 6.4213,
    standardCost: 588.9,
    todayStandardCost: 9.17,
    averageDurationMs: 4210,
    rpm: 3,
    tpm: 41_200,
  },
  providers: [
    {
      platform: "openai",
      requests: 15_200,
      tokens: 610_000_000,
      cost: 361.02,
      todayRequests: 180,
      todayTokens: 9_100_000,
      todayCost: 5.4,
      quota: [
        {
          id: "daily",
          limit: 20,
          used: 5.4,
          resetsAt: Date.now() + 6 * 60 * 60 * 1000,
        },
        {
          id: "weekly",
          limit: 100,
          used: 100,
          resetsAt: Date.now() + 3 * day,
        },
      ],
    },
    {
      platform: "grok",
      requests: 3_232,
      tokens: 97_500_000,
      cost: 51.2984,
      todayRequests: 32,
      todayTokens: 1_730_000,
      todayCost: 1.0213,
      quota: [{ id: "monthly", limit: 0, used: 0, resetsAt: null }],
    },
  ],
};

const empty: UsageOverview = {
  totals: {
    apiKeys: 0,
    activeApiKeys: 0,
    requests: 0,
    todayRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    tokens: 0,
    todayInputTokens: 0,
    todayOutputTokens: 0,
    todayCacheTokens: 0,
    todayTokens: 0,
    cost: 0,
    todayCost: 0,
    standardCost: 0,
    todayStandardCost: 0,
    averageDurationMs: 0,
    rpm: 0,
    tpm: 0,
  },
  providers: [],
};

function breakdown(range: UsageRange): UsageBreakdown {
  const hourly = range.granularity === "hour";
  const count = hourly
    ? 24
    : Math.max(
        1,
        Math.round(
          (Date.parse(range.end) - Date.parse(range.start)) / day + 1,
        ),
      );
  const trend = Array.from({ length: count }, (_, i) => {
    const wave = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + 1));
    const input = Math.round(1_800_000 * wave);
    const output = Math.round(240_000 * wave);
    const cache = Math.round(9_000_000 * wave);
    const start = Date.parse(range.start);
    const at = new Date(start + (hourly ? i * 3_600_000 : i * day));
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      date: hourly
        ? `${range.start} ${p(i)}:00`
        : `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`,
      requests: Math.round(260 * wave),
      inputTokens: input,
      outputTokens: output,
      cacheTokens: cache,
      tokens: input + output + cache,
      cost: +(7 * wave).toFixed(4),
      standardCost: +(10 * wave).toFixed(4),
    };
  });
  return {
    trend,
    models: [
      { model: "gpt-5.5", requests: 12_100, tokens: 430_000_000, cost: 280.4, standardCost: 401.2 },
      { model: "gpt-5.4-mini", requests: 3_100, tokens: 180_000_000, cost: 80.62, standardCost: 115.1 },
      { model: "grok-4.3", requests: 3_232, tokens: 97_500_000, cost: 51.2984, standardCost: 72.6 },
    ],
  };
}

function record(i: number, model: string): UsageRecord {
  return {
    id: 1000 - i,
    model,
    at: Date.now() - i * 37 * 60 * 1000,
    inputTokens: 5200 + i * 311,
    outputTokens: 640 + i * 40,
    cacheTokens: i % 2 ? 48_000 : 0,
    cost: 0.0421 + i * 0.0117,
    standardCost: 0.06 + i * 0.0161,
    durationMs: 1800 + i * 640,
    firstTokenMs: 900,
    keyName: i % 3 ? "Claudex" : "laptop",
    stream: i % 4 !== 0,
    images: i === 2 ? 1 : 0,
    effort: i % 2 ? "medium" : "",
    cacheReadTokens: i % 2 ? 46_000 : 0,
    cacheWriteTokens: i % 2 ? 2_000 : 0,
    inputCost: (5200 + i * 311) * 2e-6 * 0.25,
    outputCost: (640 + i * 40) * 1e-5 * 0.25,
    cacheReadCost: i % 2 ? 46_000 * 1e-7 * 0.25 : 0,
    cacheWriteCost: 0,
    imageCost: 0,
    multiplier: 0.25,
    group: i % 3 ? "codex" : "grok",
    endpoint: "/v1/responses",
    requestId: `req-${1000 - i}-fixture`,
    ip: "203.0.113.7",
    client: "Codex Desktop/0.159.2 (Mac OS 15.0; arm64)",
  };
}

export const usageStatsFixture: FixtureDomain = {
  params: {
    activity: "1 | empty: the account's activity under the plan's limits (off by default)",
  },
  bridge: ({ params }) => {
    const mode = params.get("activity");
    if (!mode) return {};
    return {
      usageOverview: async () => (mode === "empty" ? empty : overview),
      usageBreakdown: async (range: UsageRange) =>
        mode === "empty" ? { trend: [], models: [] } : breakdown(range),
      usageRecords: async (query: UsageRecordQuery) => {
        const names = ["gpt-5.5", "gpt-5.4-mini", "grok-4.3"];
        const all = mode === "empty"
          ? []
          : Array.from({ length: 27 }, (_, i) => record(i, names[i % 3]!)).filter(
              (r) => !query.model || r.model === query.model,
            );
        const size = query.pageSize;
        return {
          items: all.slice((query.page - 1) * size, query.page * size),
          total: all.length,
          page: query.page,
          pages: Math.max(1, Math.ceil(all.length / size)),
        };
      },
    };
  },
};
