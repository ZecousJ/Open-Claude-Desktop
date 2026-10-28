import type { WeeklyUsageStatus } from "../../shared/types";

/** The operator's weekly quota settings that the window and banner depend on. */
export interface WeeklyPolicy {
  weeklyTokenLimit: number | null;
  weeklyWarnPercent: number;
  weeklyResetDay: number;
  weeklyResetHour: number;
  moreUsageUrl: string | null;
}
export interface WeeklyWindow {
  start: number;
  end: number;
}

/**
 * The usage week containing `now`: from the most recent reset (weekday 0–6,
 * Sunday first, at a whole local hour) to the next one. Built from local
 * calendar fields, so a week spanning a daylight-saving change is 167 or
 * 169 hours long and still resets at the configured wall-clock hour.
 */
export function weeklyWindow(
  now: number,
  resetDay: number,
  resetHour: number,
): WeeklyWindow {
  const today = new Date(now);
  const at = (days: number) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + days,
      resetHour,
    ).getTime();
  let back = (today.getDay() - resetDay + 7) % 7;
  if (at(-back) > now) back += 7;
  return { start: at(-back), end: at(7 - back) };
}

/** Banner state for a week's reported token use; null when no weekly limit is set. */
export function weeklyUsageStatus(
  policy: WeeklyPolicy,
  used: number,
  now: number,
  dismissal?: WeeklyDismissal,
): WeeklyUsageStatus | null {
  const limit = policy.weeklyTokenLimit;
  if (limit === null) return null;
  const { end } = weeklyWindow(
    now,
    policy.weeklyResetDay,
    policy.weeklyResetHour,
  );
  const percent = Math.min(100, Math.floor((used / limit) * 100));
  const state =
    used >= limit
      ? "exceeded"
      : percent >= policy.weeklyWarnPercent
        ? "warning"
        : "ok";
  return {
    used,
    limit,
    percent,
    warnPercent: policy.weeklyWarnPercent,
    resetsAt: end,
    moreUsageUrl: policy.moreUsageUrl,
    state,
    dismissed: isDismissed(dismissal, end, state),
  };
}

/** What the person closed: the week (by its reset time) and whether it was already exceeded. */
export interface WeeklyDismissal {
  resetsAt: number;
  exceeded: boolean;
}
/** A dismissal lasts until the next reset, or until a warning becomes exceeded. */
export function isDismissed(
  dismissal: WeeklyDismissal | undefined,
  resetsAt: number,
  state: WeeklyUsageStatus["state"],
) {
  return (
    !!dismissal &&
    dismissal.resetsAt === resetsAt &&
    (dismissal.exceeded || state !== "exceeded")
  );
}
export function parseDismissal(value: unknown): WeeklyDismissal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { resetsAt, exceeded } = value as Record<string, unknown>;
  return Number.isSafeInteger(resetsAt) && typeof exceeded === "boolean"
    ? { resetsAt: resetsAt as number, exceeded }
    : undefined;
}
