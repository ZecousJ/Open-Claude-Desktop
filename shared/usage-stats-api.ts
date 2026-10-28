/**
 * The account's activity as the Claudex service keeps it (the Sub2API
 * dashboard's data): totals and today's figures, what each provider used and
 * its quota windows, the use over a range of days as a trend and by model,
 * and the list of requests. Settings → Usage shows them under the plan's own
 * limits.
 *
 * The desktop app asks the service from the main process with the session's
 * token; the web app asks it from the page. Both build the same addresses
 * (`usageStatsPaths`) and read the answers with the same functions, so a
 * field the service adds or drops is handled in one place.
 */
import { bridgeMethods } from "./bridge-methods";

/** Totals the service keeps for the account, today's and all time. */
export interface UsageTotals {
  apiKeys: number;
  activeApiKeys: number;
  requests: number;
  todayRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  tokens: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCacheTokens: number;
  todayTokens: number;
  /** What was charged, after the account's rate. */
  cost: number;
  todayCost: number;
  /** What the same use costs at the standard price. */
  standardCost: number;
  todayStandardCost: number;
  averageDurationMs: number;
  /** Requests and tokens a minute over the last five minutes. */
  rpm: number;
  tpm: number;
}

export type QuotaWindowId = "daily" | "weekly" | "monthly";

/** One limit of a provider: used against the limit, until it resets. */
export interface UsageQuotaWindow {
  id: QuotaWindowId;
  /** null: no limit; 0: the provider is turned off for this account. */
  limit: number | null;
  used: number;
  resetsAt: number | null;
}

export interface UsageProvider {
  /** The service's platform: openai, grok, anthropic, … */
  platform: string;
  requests: number;
  tokens: number;
  cost: number;
  todayRequests: number;
  todayTokens: number;
  todayCost: number;
  /** Only the windows that have a limit. */
  quota: UsageQuotaWindow[];
}

export interface UsageOverview {
  totals: UsageTotals;
  providers: UsageProvider[];
}

export type UsageGranularity = "day" | "hour";

export interface UsageRange {
  /** YYYY-MM-DD, the first day. */
  start: string;
  /** YYYY-MM-DD, the last day. */
  end: string;
  granularity: UsageGranularity;
}

export interface UsageTrendPoint {
  /** The bucket's label as the service sends it: a day or an hour. */
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  tokens: number;
  cost: number;
  standardCost: number;
}

export interface UsageModel {
  model: string;
  requests: number;
  tokens: number;
  cost: number;
  standardCost: number;
}

export interface UsageBreakdown {
  trend: UsageTrendPoint[];
  models: UsageModel[];
}

export interface UsageRecord {
  id: number;
  model: string;
  /** Milliseconds since the epoch. */
  at: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  standardCost: number;
  durationMs: number | null;
  firstTokenMs: number | null;
  /** The name of the API key that made the request, when the service says. */
  keyName: string;
  stream: boolean;
  images: number;
  effort: string;
  /** The parts of cacheTokens, and what each part of the bill came to. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  imageCost: number;
  /** The rate the request was billed at (1 = the standard price). */
  multiplier: number | null;
  group: string;
  /** The path the request came in on, e.g. /v1/responses. */
  endpoint: string;
  requestId: string;
  ip: string;
  client: string;
}

export interface UsageRecordQuery {
  page: number;
  pageSize: number;
  start?: string;
  end?: string;
  model?: string;
}

export interface UsageRecordPage {
  items: UsageRecord[];
  total: number;
  page: number;
  pages: number;
}

/**
 * One session's use of a model, as the service recorded it: the session's
 * requests carry its Codex thread ids (the gateway's `session_id` header),
 * and the service adds them up (GET /api/v1/claudex/session-usage).
 */
export interface SessionUsageModel {
  model: string;
  requests: number;
  /** Input not read from the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the balance was charged, in US dollars. */
  cost: number;
  /** Time the service spent on the requests. */
  durationMs: number;
}

export interface SessionUsage {
  /** Costliest first; empty when nothing was recorded for the session. */
  models: SessionUsageModel[];
}

export interface SessionUsageQuery {
  /** The session's Codex thread ids. */
  sessionIds: string[];
  /** When the session started (milliseconds since the epoch). */
  since: number;
}

export interface UsageStatsAPI {
  /** Totals, and per provider what it used and its limits. Null when the account has no service. */
  usageOverview(): Promise<UsageOverview | null>;
  /** The use over a range, day by day or hour by hour, and by model. */
  usageBreakdown(range: UsageRange): Promise<UsageBreakdown>;
  /** The requests, newest first, a page at a time. */
  usageRecords(query: UsageRecordQuery): Promise<UsageRecordPage>;
  /** One session's use by model. Null when the account has no service. */
  sessionUsage(query: SessionUsageQuery): Promise<SessionUsage | null>;
}

export const usageStatsMethods = bridgeMethods<UsageStatsAPI>({
  usageOverview: true,
  usageBreakdown: true,
  usageRecords: true,
  sessionUsage: true,
});

/** The service takes at most this many thread ids at once. */
export const maxSessionUsageIds = 20;

/** A session query, checked; anything else is refused before it reaches the service. */
export function validSessionQuery(query: SessionUsageQuery): SessionUsageQuery {
  const ids = [
    ...new Set(
      (Array.isArray(query?.sessionIds) ? query.sessionIds : [])
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id && id.length <= 255),
    ),
  ].slice(0, maxSessionUsageIds);
  if (!ids.length) throw new Error("Name the session.");
  if (!Number.isFinite(query.since)) throw new Error("Say when it started.");
  return { sessionIds: ids, since: query.since };
}

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const optional = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown, limit = 200) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const time = (value: unknown) => {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** The dates a range names, checked; anything else is refused before it reaches the service. */
export function validRange(range: UsageRange): UsageRange {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(range.start) || !day.test(range.end))
    throw new Error("Choose a range of dates.");
  if (range.start > range.end)
    throw new Error("The range starts after it ends.");
  return {
    start: range.start,
    end: range.end,
    granularity: range.granularity === "hour" ? "hour" : "day",
  };
}

/** Addresses under `/api/v1`, with the browser's time zone so days start where the person is. */
export const usageStatsPaths = {
  stats: () => "/usage/dashboard/stats",
  quotas: () => "/user/platform-quotas",
  trend: (range: UsageRange, timezone: string) =>
    `/usage/dashboard/trend?${new URLSearchParams({
      start_date: range.start,
      end_date: range.end,
      granularity: range.granularity,
      timezone,
    })}`,
  models: (range: UsageRange, timezone: string) =>
    `/usage/dashboard/models?${new URLSearchParams({
      start_date: range.start,
      end_date: range.end,
      timezone,
    })}`,
  records: (query: UsageRecordQuery, timezone: string) => {
    const params = new URLSearchParams({
      page: String(Math.max(1, Math.trunc(query.page) || 1)),
      page_size: String(
        Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 20)),
      ),
      timezone,
    });
    if (query.start) params.set("start_date", query.start);
    if (query.end) params.set("end_date", query.end);
    if (query.model) params.set("model", query.model.slice(0, 200));
    return `/usage?${params}`;
  },
  /** A Claudex route: the session's ids, and its start (a minute early, for clocks that differ). */
  session: (query: SessionUsageQuery) => {
    const params = new URLSearchParams();
    for (const id of query.sessionIds) params.append("session_id", id);
    params.set("since", new Date(query.since - 60_000).toISOString());
    return `/claudex/session-usage?${params}`;
  },
};

/** The service's answer to `usageStatsPaths.session`. */
export function sessionUsageFrom(raw: unknown): SessionUsage {
  const models = record(raw).models;
  return {
    models: (Array.isArray(models) ? models : [])
      .slice(0, 50)
      .flatMap((entry): SessionUsageModel[] => {
        const m = record(entry);
        const model = text(m.model, 200);
        if (!model) return [];
        return [
          {
            model,
            requests: number(m.requests),
            inputTokens: number(m.input_tokens),
            outputTokens: number(m.output_tokens),
            cacheReadTokens: number(m.cache_read_tokens),
            cacheWriteTokens: number(m.cache_creation_tokens),
            cost: number(m.actual_cost),
            durationMs: number(m.duration_ms),
          },
        ];
      }),
  };
}

const windows: QuotaWindowId[] = ["daily", "weekly", "monthly"];

function quotaFrom(raw: unknown): UsageQuotaWindow[] {
  const item = record(raw);
  const out: UsageQuotaWindow[] = [];
  for (const id of windows) {
    const limit = optional(item[`${id}_limit_usd`]);
    if (limit === null) continue;
    out.push({
      id,
      limit,
      used: number(item[`${id}_usage_usd`]),
      resetsAt: time(item[`${id}_window_resets_at`]),
    });
  }
  return out;
}

/** The dashboard stats and the account's platform quotas as one overview. */
export function overviewFrom(
  rawStats: unknown,
  rawQuotas: unknown,
): UsageOverview {
  const s = record(rawStats);
  const quotas = new Map<string, UsageQuotaWindow[]>();
  const list = record(rawQuotas).platform_quotas;
  if (Array.isArray(list))
    for (const entry of list) {
      const platform = text(record(entry).platform, 40);
      const windowsOf = quotaFrom(entry);
      if (platform && windowsOf.length) quotas.set(platform, windowsOf);
    }
  const providers = new Map<string, UsageProvider>();
  const listed = Array.isArray(s.by_platform) ? s.by_platform : [];
  for (const entry of listed) {
    const p = record(entry);
    const platform = text(p.platform, 40);
    if (!platform) continue;
    providers.set(platform, {
      platform,
      requests: number(p.total_requests),
      tokens: number(p.total_tokens),
      cost: number(p.total_actual_cost),
      todayRequests: number(p.today_requests),
      todayTokens: number(p.today_tokens),
      todayCost: number(p.today_actual_cost),
      quota: quotas.get(platform) ?? [],
    });
  }
  // A provider with a limit but no use yet is still listed, with its limits.
  for (const [platform, quota] of quotas)
    if (!providers.has(platform))
      providers.set(platform, {
        platform,
        requests: 0,
        tokens: 0,
        cost: 0,
        todayRequests: 0,
        todayTokens: 0,
        todayCost: 0,
        quota,
      });
  return {
    totals: {
      apiKeys: number(s.total_api_keys),
      activeApiKeys: number(s.active_api_keys),
      requests: number(s.total_requests),
      todayRequests: number(s.today_requests),
      inputTokens: number(s.total_input_tokens),
      outputTokens: number(s.total_output_tokens),
      cacheTokens:
        number(s.total_cache_creation_tokens) +
        number(s.total_cache_read_tokens),
      tokens: number(s.total_tokens),
      todayInputTokens: number(s.today_input_tokens),
      todayOutputTokens: number(s.today_output_tokens),
      todayCacheTokens:
        number(s.today_cache_creation_tokens) +
        number(s.today_cache_read_tokens),
      todayTokens: number(s.today_tokens),
      cost: number(s.total_actual_cost),
      todayCost: number(s.today_actual_cost),
      standardCost: number(s.total_cost),
      todayStandardCost: number(s.today_cost),
      averageDurationMs: number(s.average_duration_ms),
      rpm: number(s.rpm),
      tpm: number(s.tpm),
    },
    providers: [...providers.values()].sort(
      (a, b) => b.cost - a.cost || a.platform.localeCompare(b.platform),
    ),
  };
}

export function breakdownFrom(
  rawTrend: unknown,
  rawModels: unknown,
): UsageBreakdown {
  const trend = record(rawTrend).trend;
  const models = record(rawModels).models;
  return {
    trend: (Array.isArray(trend) ? trend : []).slice(0, 800).map((entry) => {
      const p = record(entry);
      return {
        date: text(p.date, 40),
        requests: number(p.requests),
        inputTokens: number(p.input_tokens),
        outputTokens: number(p.output_tokens),
        cacheTokens:
          number(p.cache_creation_tokens) + number(p.cache_read_tokens),
        tokens: number(p.total_tokens),
        cost: number(p.actual_cost),
        standardCost: number(p.cost),
      };
    }),
    models: (Array.isArray(models) ? models : []).slice(0, 200).map((entry) => {
      const m = record(entry);
      return {
        model: text(m.model, 200),
        requests: number(m.requests),
        tokens: number(m.total_tokens),
        cost: number(m.actual_cost),
        standardCost: number(m.cost),
      };
    }),
  };
}

export function recordsFrom(raw: unknown): UsageRecordPage {
  const page = record(raw);
  const items = Array.isArray(page.items) ? page.items : [];
  return {
    items: items.slice(0, 100).flatMap((entry): UsageRecord[] => {
      const r = record(entry);
      const id = r.id;
      if (!Number.isSafeInteger(id)) return [];
      return [
        {
          id: id as number,
          model: text(r.model, 200),
          at: time(r.created_at) ?? 0,
          inputTokens: number(r.input_tokens),
          outputTokens: number(r.output_tokens),
          cacheTokens:
            number(r.cache_creation_tokens) + number(r.cache_read_tokens),
          cost: number(r.actual_cost),
          standardCost: number(r.total_cost),
          durationMs: optional(r.duration_ms),
          firstTokenMs: optional(r.first_token_ms),
          keyName: text(record(r.api_key).name, 100),
          stream: r.stream === true,
          images: number(r.image_count),
          effort: text(r.reasoning_effort, 20),
          cacheReadTokens: number(r.cache_read_tokens),
          cacheWriteTokens: number(r.cache_creation_tokens),
          inputCost: number(r.input_cost),
          outputCost: number(r.output_cost),
          cacheReadCost: number(r.cache_read_cost),
          cacheWriteCost: number(r.cache_creation_cost),
          imageCost: number(r.image_input_cost) + number(r.image_output_cost),
          multiplier: optional(r.rate_multiplier),
          group: text(record(r.group).name, 100),
          endpoint: text(r.inbound_endpoint, 200),
          requestId: text(r.request_id, 200),
          ip: text(r.ip_address, 100),
          client: text(r.user_agent, 300),
        },
      ];
    }),
    total: number(page.total),
    page: Math.max(1, number(page.page) || 1),
    pages: Math.max(1, number(page.pages) || 1),
  };
}
