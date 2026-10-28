/**
 * The activity calls (shared/usage-stats-api.ts) on the web: plain requests
 * to the service's usage endpoints with the session's token.
 */
import {
  breakdownFrom,
  overviewFrom,
  recordsFrom,
  sessionUsageFrom,
  usageStatsPaths,
  validRange,
  validSessionQuery,
  type SessionUsageQuery,
  type UsageRange,
  type UsageRecordQuery,
  type UsageStatsAPI,
} from "../../shared/usage-stats-api";
import type { WebTransport } from "../../shared/web-client/transport";

type Method = (...args: any[]) => Promise<unknown>;

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const wrapped = body as { data?: unknown } | undefined;
  return wrapped && typeof wrapped === "object" && "data" in wrapped
    ? wrapped.data
    : body;
}

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function createUsageStatsMethods(
  transport: Pick<WebTransport, "json">,
): { [K in keyof UsageStatsAPI]: Method } {
  return {
    usageOverview: async () => {
      const stats = data(
        await transport.json(`/api/v1${usageStatsPaths.stats()}`),
      );
      // The limits are a courtesy: a service that can't say has none.
      const quotas = await transport
        .json(`/api/v1${usageStatsPaths.quotas()}`)
        .then(data, () => undefined);
      return overviewFrom(stats, quotas);
    },
    usageBreakdown: async (raw: UsageRange) => {
      const range = validRange(raw);
      const [trend, models] = await Promise.all([
        transport.json(`/api/v1${usageStatsPaths.trend(range, timezone())}`),
        transport.json(`/api/v1${usageStatsPaths.models(range, timezone())}`),
      ]);
      return breakdownFrom(data(trend), data(models));
    },
    usageRecords: async (query: UsageRecordQuery) =>
      recordsFrom(
        data(
          await transport.json(
            `/api/v1${usageStatsPaths.records(query, timezone())}`,
          ),
        ),
      ),
    sessionUsage: async (raw: SessionUsageQuery) =>
      sessionUsageFrom(
        data(
          await transport.json(
            `/api/v1${usageStatsPaths.session(validSessionQuery(raw))}`,
          ),
        ),
      ),
  };
}
