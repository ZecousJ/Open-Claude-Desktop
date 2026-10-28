/**
 * Plan usage and the weekly usage banner (package C4). Nothing is fetched:
 * the numbers are synthetic and the links point at example.com.
 */
import type {
  LimitReason,
  PlanUsage,
  PlanUsageWindow,
  WeeklyUsageStatus,
} from "../../../shared/usage-api";
import {
  weeklyUsageStatus,
  type WeeklyDismissal,
} from "../../../electron/conversations/weekly-usage";
import type { FixtureDomain } from "./index";

const hour = 60 * 60 * 1000;
const day = 24 * hour;

/** The next `weekday` (0 Sunday) at `hourOfDay`:00 local time after `now`. */
function next(now: number, weekday: number, hourOfDay: number) {
  const at = new Date(now);
  at.setHours(hourOfDay, 0, 0, 0);
  at.setDate(at.getDate() + ((weekday - at.getDay() + 7) % 7));
  if (at.getTime() <= now) at.setDate(at.getDate() + 7);
  return at.getTime();
}

function limit(
  kind: PlanUsageWindow["kind"],
  label: string,
  windowSeconds: number,
  usedUsd: number,
  limitUsd: number,
  resetsAt: number | null,
  id = `rule:${kind}`,
): PlanUsageWindow {
  return {
    id,
    kind,
    label,
    windowSeconds,
    usedUsd,
    limitUsd,
    percent: Math.min(100, Math.round((usedUsd / limitUsd) * 100)),
    resetsAt,
    active: resetsAt !== null,
    exceeded: usedUsd >= limitUsd,
    models: kind === "models" ? ["claude-opus-*"] : null,
  };
}

/** The windows `usage-status` would send for each scenario, in its order. */
function usageWindows(scenario: string, now: number): PlanUsageWindow[] {
  const week = 604_800;
  const monday = next(now, 1, 17);
  switch (scenario) {
    case "empty":
    case "balance":
      return [];
    case "legacy":
      // /subscriptions/progress: weekly, daily and monthly caps only.
      return [
        limit("all_models", "All models", week, 8.5, 10, monday, "subscription:weekly"),
        limit("daily", "Daily", 86_400, 0.5, 2, now + 3.2 * hour, "subscription:daily"),
        limit("monthly", "Monthly", 2_592_000, 40, 40, now + 18 * day, "subscription:monthly"),
      ];
    case "limit":
      return [
        limit("session", "Current session", 18_000, 5, 5, now + 3.5 * hour),
        limit("all_models", "All models", week, 49, 100, monday, "subscription:weekly"),
        limit("models", "Opus", week, 0, 20, null),
      ];
    default:
      return [
        limit("session", "Current session", 18_000, 1.5, 5, now + 4.5 * hour),
        limit("all_models", "All models", week, 8, 100, monday, "subscription:weekly"),
        limit("models", "Opus", week, 0, 20, null),
      ];
  }
}
/** The operator's default weekly policy (Monday 17:00, warn at 80%) over a 5M-token limit. */
const weeklyLimit = 5_000_000;

export const usageFixture: FixtureDomain = {
  params: {
    weekly:
      "percent of the weekly limit used (default 85); none hides the banner",
    moreUsage: "none hides Get more usage",
    reason:
      "daily|weekly|monthly|key-quota|balance|subscription, with weekly=100",
    globalLimit:
      "session|rate-limit: the window's corner notice (R-0127, R-0314)",
    plan: "a Sub2API plan name: the Usage page's plan",
    usageWait: "forever: Settings → Usage stays on its loading placeholders",
    usage:
      "Settings → Usage windows: reference (default, R-1304), limit (session at 100%), legacy (/subscriptions/progress), balance, empty",
  },
  bridge: ({ params, origin }) => {
    const percent =
      params.get("weekly") === "none"
        ? null
        : params.has("weekly")
          ? Number(params.get("weekly"))
          : 85;
    const moreUsageUrl =
      params.get("moreUsage") === "none"
        ? null
        : "https://usage.example.com/claudex";
    const reason = (params.get("reason") ?? undefined) as
      LimitReason | undefined;
    const plan = params.get("plan") ?? undefined;
    const scenario = params.get("usage") ?? "reference";
    // Relative to the (fixture's) clock, so the reset times read naturally.
    const planUsage = (now = Date.now()): PlanUsage => ({
      plan: plan ?? "",
      expiresAt: scenario === "legacy" ? now + 20 * 24 * hour : null,
      windows: usageWindows(scenario, now),
      updatedAt: Date.now(),
      warnPercent: 80,
      learnMoreUrl: "https://docs.example.com/usage",
      balanceUsd: scenario === "balance" ? 12.34 : null,
    });
    let dismissal: WeeklyDismissal | undefined;
    const weekly = (): WeeklyUsageStatus | null => {
      if (percent === null) return null;
      const status = weeklyUsageStatus(
        {
          weeklyTokenLimit: weeklyLimit,
          weeklyWarnPercent: 80,
          weeklyResetDay: 1,
          weeklyResetHour: 17,
          moreUsageUrl,
        },
        Math.round((weeklyLimit * percent) / 100),
        origin,
        dismissal,
      );
      const shown =
        status && reason && status.state === "exceeded"
          ? { ...status, reason, unit: "usd" as const }
          : status;
      const kind = params.get("globalLimit");
      return shown && (kind === "session" || kind === "rate-limit")
        ? { ...shown, globalLimit: { kind, resetsAt: Date.now() + 8 * hour } }
        : shown;
    };
    return {
      weeklyUsageStatus: async () => weekly(),
      dismissWeeklyUsage: async (seen) => {
        const status = weekly();
        if (status)
          dismissal = {
            resetsAt: status.resetsAt,
            exceeded: status.state === "exceeded" && seen === "exceeded",
          };
        return weekly();
      },
      planUsage: async () => {
        // usageWait=forever keeps the page on its placeholders.
        if (params.get("usageWait") === "forever")
          await new Promise(() => undefined);
        return plan ? planUsage() : null;
      },
    };
  },
};
