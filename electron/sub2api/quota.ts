import type { PlanUsageWindow, WeeklyUsageStatus } from "../../shared/types";
import type {
  ClaudexUsageStatus,
  GatewayRefusalDetails,
} from "../../shared/claudex-contract";
import { bannerWindow, blockedUntil } from "../../shared/plan-usage";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import {
  isDismissed,
  type WeeklyDismissal,
} from "../conversations/weekly-usage";
import type { SubscriptionProgress, UsageWindow } from "./client";

/**
 * The banner's warning threshold and Get more usage page: the
 * administrator's policy (`usageBanner.warnPercent`, `links.getMoreUsage`).
 */
export interface BannerPolicy {
  warnPercent: number;
  moreUsageUrl: string | null;
}
/** A refusal that keeps the banner exceeded until `until` or the next successful turn. */
export interface LimitBlock {
  refusal: GatewayRefusal;
  at: number;
  until: number;
}
/** A refusal with the reset time the Claudex service attaches (package C3 fills it). */
export type TimedRefusal = GatewayRefusal &
  Pick<GatewayRefusalDetails, "resetsAt">;

const week = 7 * 24 * 60 * 60 * 1000;

/** The progress entry for the plan's group, else the first one. */
export function selectProgress(
  entries: SubscriptionProgress[],
  groupId: number | undefined,
) {
  return entries.find((entry) => entry.groupId === groupId) ?? entries[0];
}

/** In the service's order: weekly before daily and monthly. */
const progressWindows = [
  ["weekly", "all_models", "All models", 604_800],
  ["daily", "daily", "Daily", 86_400],
  ["monthly", "monthly", "Monthly", 2_592_000],
] as const;

/**
 * A plan's windows from `/subscriptions/progress` (services without
 * `usage-status`), in the same shape and order the Claudex service uses:
 * the weekly cap is an all-models window.
 */
export function planWindows(progress: SubscriptionProgress): PlanUsageWindow[] {
  return progressWindows.flatMap(([key, kind, label, seconds]) => {
    const window = progress[key];
    if (!window || !(window.limitUsd > 0)) return [];
    const percent = Math.min(100, Math.max(0, window.percentage));
    return [
      {
        id: `subscription:${key}`,
        kind,
        label,
        windowSeconds: seconds,
        usedUsd: window.usedUsd,
        limitUsd: window.limitUsd,
        percent,
        resetsAt: window.resetsAt,
        active: true,
        exceeded: window.usedUsd >= window.limitUsd || percent >= 100,
        models: null,
      } satisfies PlanUsageWindow,
    ];
  });
}

function status(
  used: number,
  limit: number,
  percent: number,
  resetsAt: number,
  policy: BannerPolicy,
  dismissal: WeeklyDismissal | undefined,
): WeeklyUsageStatus {
  const whole = Math.min(100, Math.floor(percent));
  const state =
    used >= limit || percent >= 100
      ? "exceeded"
      : whole >= policy.warnPercent
        ? "warning"
        : "ok";
  return {
    used,
    limit,
    percent: whole,
    warnPercent: policy.warnPercent,
    resetsAt,
    moreUsageUrl: policy.moreUsageUrl,
    state,
    dismissed: isDismissed(dismissal, resetsAt, state),
    unit: "usd",
  };
}

/** The plan's weekly window from `/subscriptions/progress`, in USD. */
export function weeklyFromProgress(
  weekly: UsageWindow | undefined,
  policy: BannerPolicy,
  dismissal?: WeeklyDismissal,
): WeeklyUsageStatus | null {
  if (!weekly || weekly.limitUsd <= 0) return null;
  return status(
    weekly.usedUsd,
    weekly.limitUsd,
    weekly.percentage,
    weekly.resetsAt,
    policy,
    dismissal,
  );
}

/**
 * The banner from `usage-status`: the all-models window closest to its
 * limit; a window that has not started resets a full window after now.
 * While the service reports a blocking window, the banner is exceeded until
 * that window resets, with the weekly numbers kept.
 */
export function weeklyFromUsageStatus(
  usage: ClaudexUsageStatus,
  windows: PlanUsageWindow[],
  policy: BannerPolicy,
  now: number,
  dismissal?: WeeklyDismissal,
): WeeklyUsageStatus | null {
  const weekly = bannerWindow(windows);
  const base = weekly
    ? status(
        weekly.usedUsd,
        weekly.limitUsd,
        weekly.exceeded ? 100 : weekly.percent,
        weekly.resetsAt ?? now + (weekly.windowSeconds ?? 604_800) * 1000,
        policy,
        dismissal,
      )
    : null;
  const until = blockedUntil(usage, now);
  if (!until || base?.state === "exceeded") return base;
  return {
    used: base?.used ?? 0,
    limit: base?.limit ?? 0,
    percent: base?.percent ?? 100,
    warnPercent: policy.warnPercent,
    resetsAt: until,
    moreUsageUrl: policy.moreUsageUrl,
    state: "exceeded",
    dismissed: isDismissed(dismissal, until, "exceeded"),
    unit: "usd",
  };
}

/**
 * The key's own 7-day cap from gateway `GET /v1/usage` (`rate_limits`
 * window "7d"). A window that has not started yet resets a week from now.
 */
export function weeklyFromKeyUsage(
  body: unknown,
  policy: BannerPolicy,
  now: number,
  dismissal?: WeeklyDismissal,
): WeeklyUsageStatus | null {
  const limits = (body as { rate_limits?: unknown })?.rate_limits;
  if (!Array.isArray(limits)) return null;
  const entry = limits.find(
    (item) => (item as { window?: unknown })?.window === "7d",
  ) as Record<string, unknown> | undefined;
  const limit = Number(entry?.limit),
    used = Number(entry?.used);
  if (!entry || !(limit > 0) || !(used >= 0)) return null;
  const start =
    typeof entry.window_start === "string"
      ? Date.parse(entry.window_start)
      : NaN;
  const resetsAt = Number.isFinite(start) ? start + week : now + week;
  return status(used, limit, (used / limit) * 100, resetsAt, policy, dismissal);
}

/**
 * How long a refusal holds the exceeded banner: until the reset the
 * service named (`resets_at`), else until the refused plan window resets
 * (older services), else a week.
 */
export function blockFor(
  refusal: TimedRefusal,
  progress: SubscriptionProgress | undefined,
  now: number,
): LimitBlock {
  if (refusal.resetsAt && refusal.resetsAt > now)
    return { refusal, at: now, until: refusal.resetsAt };
  const window =
    refusal.reason === "daily" ||
    refusal.reason === "weekly" ||
    refusal.reason === "monthly"
      ? progress?.[refusal.reason]
      : undefined;
  return {
    refusal,
    at: now,
    until: window && window.resetsAt > now ? window.resetsAt : now + week,
  };
}

/** The banner while the service refuses requests; the plan's weekly numbers stay when there are some. */
export function blockedStatus(
  base: WeeklyUsageStatus | null,
  block: LimitBlock,
  policy: BannerPolicy,
  dismissal: WeeklyDismissal | undefined,
): WeeklyUsageStatus {
  const timed = (block.refusal as TimedRefusal).resetsAt !== undefined;
  const resetsAt =
    block.refusal.reason === "weekly" && base && !timed
      ? base.resetsAt
      : block.until;
  return {
    used: base?.used ?? 0,
    limit: base?.limit ?? 0,
    percent: block.refusal.reason === "weekly" ? 100 : (base?.percent ?? 100),
    warnPercent: policy.warnPercent,
    resetsAt,
    moreUsageUrl: policy.moreUsageUrl,
    state: "exceeded",
    dismissed: isDismissed(dismissal, resetsAt, "exceeded"),
    unit: "usd",
    reason: block.refusal.reason,
  };
}
