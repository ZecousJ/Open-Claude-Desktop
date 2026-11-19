import { profileReadLease } from "../account/profile-read-lease";
import { confirmedUsageOverview, confirmedUsageBreakdown, confirmedUsageRecords } from "../../shared/usage-stats-confirmed";
import { z } from "zod";
import {
  sessionUsageFrom,
  usageStatsMethods,
  usageStatsPaths,
  usageTimezone,
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
const timezone = z.string().transform((value, ctx) => {
  const name = usageTimezone(value);
  if (name !== undefined) return name;
  ctx.addIssue({ code: 'custom', message: 'Invalid time zone.' });
  return z.NEVER;
}).optional();
const overviewQuery = z.object({ timezone }).strict().optional();
const range = z
  .object({ start: day, end: day, granularity: z.enum(["day", "hour"]), timezone })
  .strict();
const query = z
  .object({
    page: z.number().int().min(1).max(100_000),
    pageSize: z.number().int().min(1).max(100),
    start: day.optional(),
    end: day.optional(),
    model: z.string().max(200).optional(),
    timezone,
  })
  .strict();
const sessionQuery = z
  .object({
    sessionIds: z.array(z.string().max(255)).min(1).max(50),
    since: z.number().finite(),
  })
  .strict();

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The account's activity from the service (shared/usage-stats-api.ts), read
 * with the session's token in the main process. An account without a Claudex
 * session has none.
 */
export function registerUsageStatsHandlers(handle: IpcHandle, ctx: AppContext) {
  const capture = profileReadLease(ctx);
  const source = () => {
    const lease = capture();
    const check = () => { if (!lease.current()) throw Error("The account changed while reading usage."); };
    check();
    const backend = lease.host?.ready ? lease.host.backend : undefined;
    const get = async (path: string) => {
      check();
      if (!backend) throw Error("Usage is unavailable for this account.");
      const result = await backend.session.authorized((token) => {
        check();
        return requestJson(fetch, `${backend.accounts.baseUrl}/api/v1${path}`, { token });
      }, lease.current);
      check();
      return result;
    };
    return { backend, get, check };
  };
  const data = (body: unknown) =>
    body && typeof body === "object" && "data" in body
      ? (body as { data: unknown }).data
      : body;
  handle("usageOverview", async (raw?: unknown): Promise<UsageOverview | null> => {
    const checked = overviewQuery.parse(raw);
    const { backend, get, check } = source();
    if (!backend) return null;
    const stats = data(await get(usageStatsPaths.stats(checked?.timezone)));
    // The limits are a courtesy: a service that can't say has none.
    const quotas = await get(usageStatsPaths.quotas()).then(
      data,
      () => undefined,
    );
    check();
    return confirmedUsageOverview(stats, quotas);
  });
  handle("usageBreakdown", async (raw: unknown): Promise<UsageBreakdown> => {
    const checked = validRange(range.parse(raw));
    const { backend, get, check } = source();
    if (!backend) throw Error("Usage is unavailable for this account.");
    const reportingTimezone = checked.timezone ?? localTimezone();
    const [trend, models] = await Promise.all([
      get(usageStatsPaths.trend(checked, reportingTimezone)),
      get(usageStatsPaths.models(checked, reportingTimezone)),
    ]);
    check();
    return confirmedUsageBreakdown(data(trend), data(models));
  });
  handle("usageRecords", async (raw: unknown): Promise<UsageRecordPage> => {
    const checked = query.parse(raw);
    const { backend, get, check } = source();
    if (!backend) throw Error("Usage is unavailable for this account.");
    return confirmedUsageRecords(
      data(await get(usageStatsPaths.records(checked, checked.timezone ?? localTimezone()))),
    );
  });
  handle("sessionUsage", async (raw: unknown): Promise<SessionUsage | null> => {
    const checked = validSessionQuery(sessionQuery.parse(raw));
    const { backend, get, check } = source();
    if (!backend) return null;
    return sessionUsageFrom(
      data(await get(usageStatsPaths.session(checked))),
    );
  });
  // Keeps this list and the bridge's in step.
  void usageStatsMethods;
}
