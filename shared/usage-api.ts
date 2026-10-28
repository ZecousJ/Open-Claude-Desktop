/**
 * Plan usage and the weekly usage banner (package C4). `shared/types.ts`
 * re-exports these types so older imports keep working; new usage types and
 * bridge methods are added here.
 */
import { bridgeMethods } from "./bridge-methods";

/**
 * Why the service refuses requests: a plan window, the key's own quota,
 * balance or plan state. The Claudex service names more limits (session,
 * per-model rules); packages C3/C4 append their values here, so code that
 * switches on it keeps a fallback for values it does not show.
 */
export type LimitReason =
  | "daily"
  | "weekly"
  | "monthly"
  | "key-quota"
  | "balance"
  | "subscription"
  // C3: a Claudex usage rule refused the request (design 2.6). "session" is
  // a rule over all models with an hours-long window ("Current session");
  // "model" is a rule over some models only, the others keep working.
  | "session"
  | "model";

/** The current account's operator-set weekly token quota (reported input + output tokens). */
export interface WeeklyUsageStatus {
  used: number;
  limit: number;
  /** Whole percent of the limit used, capped at 100. */
  percent: number;
  warnPercent: number;
  /** Epoch ms of the next weekly reset. */
  resetsAt: number;
  /** Operator-configured https page for more usage, if any. */
  moreUsageUrl: string | null;
  state: "ok" | "warning" | "exceeded";
  /** The person closed the banner for this week (reopens once exceeded). */
  dismissed: boolean;
  /** Tokens for the local limit; US dollars for a Sub2API plan. */
  unit?: "tokens" | "usd";
  /** Which limit refused requests, when the service said so. */
  reason?: LimitReason;
  /**
   * The window-wide notice at the bottom right: the 5-hour session limit or the
   * service's request rate limit refused the last request. Absent otherwise;
   * the status is then about the banner only.
   */
  globalLimit?: GlobalLimitNotice;
  /**
   * "Get notified" in the exceeded banner: "available" when this computer
   * can show a system notification at `resetsAt`, "scheduled" once asked.
   * Absent when notifications cannot be shown (the button is not offered).
   */
  resetNotification?: "available" | "scheduled";
}

/** Which limit, and when it resets (null when unknown). */
export interface GlobalLimitNotice {
  kind: "session" | "rate-limit";
  resetsAt: number | null;
}

/**
 * The kinds of usage window the Claudex service reports (design 2.6): the
 * 5-hour session, weekly all-models and per-model rules, the subscription's
 * daily and monthly caps and this device key's own limits. A subscription's
 * weekly cap is an `all_models` window.
 */
export type PlanUsageKind =
  "session" | "all_models" | "models" | "daily" | "monthly" | "key";

/** One of a plan's usage windows, in US dollars. */
export interface PlanUsageWindow {
  /** Stable id such as "rule:3" or "subscription:weekly". */
  id: string;
  kind: PlanUsageKind;
  /** The service's name for it: "Current session", "All models", "Opus"… */
  label: string;
  /** Length of the window in seconds; null when the service did not say. */
  windowSeconds: number | null;
  usedUsd: number;
  limitUsd: number;
  /** Percent used, 0–100. */
  percent: number;
  /** Epoch ms of the next reset; null while the window has not started. */
  resetsAt: number | null;
  /** A first request opened the window. */
  active: boolean;
  /** The service refuses requests until the window resets. */
  exceeded: boolean;
  /** Model patterns of a per-model limit; null for all models. */
  models: string[] | null;
}

/** The signed-in person's plan and its limits, for the Plan usage limits page. */
export interface PlanUsage {
  plan: string;
  expiresAt: number | null;
  /** In the service's order: session, weekly, per-model, daily, monthly, device. */
  windows: PlanUsageWindow[];
  updatedAt: number;
  warnPercent: number;
  /** "Learn more about usage limits": the administrator's page, when there is one. */
  learnMoreUrl: string | null;
  /** The account balance when the plan is paid from it (Claudex service only). */
  balanceUsd?: number | null;
}

/** A Claudex surface in the usage by product (backend usage/products.go). */
export type UsageProduct = "code" | "cowork" | "chat" | "other";
export type UsageProductRange = "7" | "30" | "month" | "yesterday";

/** Billed cost by product over a range of UTC days. */
export interface ProductUsage {
  from: string;
  to: string;
  totals: Partial<Record<UsageProduct, number>>;
  requests: Partial<Record<UsageProduct, number>>;
  days: { day: string; costUsd: Partial<Record<UsageProduct, number>> }[];
}

export interface UsageAPI {
  /** Usage by product; null without a Claudex account or such a service. */
  usageProducts(range?: UsageProductRange): Promise<ProductUsage | null>;
  weeklyUsageStatus(): Promise<WeeklyUsageStatus | null>;
  /** Closes the banner; `seen` is the state it showed when closed. */
  dismissWeeklyUsage(
    seen: WeeklyUsageStatus["state"],
  ): Promise<WeeklyUsageStatus | null>;
  /** The plan's usage windows; null without a Sub2API plan. */
  planUsage(fresh?: boolean): Promise<PlanUsage | null>;
  /**
   * "Get notified": a system notification when the limit that refuses
   * requests resets. Returns the status with `resetNotification`
   * "scheduled", or unchanged when no notification can be shown.
   */
  notifyWhenUsageResets(): Promise<WeeklyUsageStatus | null>;
}

export const usageMethods = bridgeMethods<UsageAPI>({
  usageProducts: true,
  weeklyUsageStatus: true,
  dismissWeeklyUsage: true,
  planUsage: true,
  notifyWhenUsageResets: true,
});
