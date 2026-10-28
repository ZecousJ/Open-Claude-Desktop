import { z } from "zod";
import {
  breakdownFrom,
  overviewFrom,
  recordsFrom,
  sessionUsageFrom,
  usageStatsMethods,
  usageStatsPaths,
  validRange,
  validSessionQuery,
  type SessionUsage,
  type UsageBreakdown,
  type UsageOverview,
  type UsageRecordPage,
} from "../../shared/usage-stats-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z
  .object({ start: day, end: day, granularity: z.enum(["day", "hour"]) })
  .strict();
const query = z
  .object({
    page: z.number().int().min(1).max(100_000),
    pageSize: z.number().int().min(1).max(100),
    start: day.optional(),
    end: day.optional(),
    model: z.string().max(200).optional(),
  })
  .strict();
const sessionQuery = z
  .object({
    sessionIds: z.array(z.string().max(255)).min(1).max(50),
    since: z.number().finite(),
  })
  .strict();

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The account's activity from the service (shared/usage-stats-api.ts), read
 * with the session's token in the main process. An account without a Claudex
 * session has none.
 */
export function registerUsageStatsHandlers(handle: IpcHandle, ctx: AppContext) {
  const service = () => (ctx.remote?.ready ? ctx.remote.backend : undefined);
  const get = (
    backend: NonNullable<ReturnType<typeof service>>,
    path: string,
  ) =>
    backend.session.authorized((token) =>
      requestJson(fetch, `${backend.accounts.baseUrl}/api/v1${path}`, {
        token,
      }),
    );
  const data = (body: unknown) =>
    body && typeof body === "object" && "data" in body
      ? (body as { data: unknown }).data
      : body;
  handle("usageOverview", async (): Promise<UsageOverview | null> => {
    const backend = service();
    if (!backend) return null;
    const stats = data(await get(backend, usageStatsPaths.stats()));
    // The limits are a courtesy: a service that can't say has none.
    const quotas = await get(backend, usageStatsPaths.quotas()).then(
      data,
      () => undefined,
    );
    return overviewFrom(stats, quotas);
  });
  handle("usageBreakdown", async (raw: unknown): Promise<UsageBreakdown> => {
    const checked = validRange(range.parse(raw));
    const backend = service();
    if (!backend) return { trend: [], models: [] };
    const [trend, models] = await Promise.all([
      get(backend, usageStatsPaths.trend(checked, timezone())),
      get(backend, usageStatsPaths.models(checked, timezone())),
    ]);
    return breakdownFrom(data(trend), data(models));
  });
  handle("usageRecords", async (raw: unknown): Promise<UsageRecordPage> => {
    const checked = query.parse(raw);
    const backend = service();
    if (!backend) return { items: [], total: 0, page: 1, pages: 1 };
    return recordsFrom(
      data(await get(backend, usageStatsPaths.records(checked, timezone()))),
    );
  });
  handle("sessionUsage", async (raw: unknown): Promise<SessionUsage | null> => {
    const checked = validSessionQuery(sessionQuery.parse(raw));
    const backend = service();
    if (!backend) return null;
    return sessionUsageFrom(
      data(await get(backend, usageStatsPaths.session(checked))),
    );
  });
  // Keeps this list and the bridge's in step.
  void usageStatsMethods;
}
