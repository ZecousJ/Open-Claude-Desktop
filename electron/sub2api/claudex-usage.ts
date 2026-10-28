/**
 * The Claudex service's usage windows (`GET /api/v1/claudex/usage-status`,
 * design 2.6; package C4): session, weekly and per-model rules next to the
 * subscription's caps. Older Sub2API services do not have the route; the
 * caller then keeps reading `/subscriptions/progress`.
 */
import {
  parseUsageStatus,
  type ClaudexUsageStatus,
} from "../../shared/claudex-contract";
import { planWindowsFromStatus } from "../../shared/plan-usage";
import type { PlanUsage } from "../../shared/usage-api";
import { requestJson, Sub2ApiError, type Fetch } from "./http";

/** The Plan usage limits page from `usage-status`. */
export function planUsageFromStatus(
  status: ClaudexUsageStatus,
  page: {
    plan: string | undefined;
    expiresAt: number | null;
    warnPercent: number;
    learnMoreUrl: string | null;
    readAt: number;
  },
): PlanUsage {
  return {
    plan: page.plan || status.plan.groupName,
    expiresAt: page.expiresAt,
    windows: planWindowsFromStatus(status),
    // When this client read it: "Last updated" counts from the refresh.
    updatedAt: page.readAt,
    warnPercent: page.warnPercent,
    learnMoreUrl: page.learnMoreUrl,
    balanceUsd:
      status.plan.billingMode === "balance" && status.balance
        ? status.balance.balanceUsd
        : null,
  };
}

/** Plan windows change with every request; a short cache keeps the page and banner from asking twice. */
export const usageCacheMs = 15_000;

/** One read of `usage-status` for the signed-in account. */
export function fetchUsageStatus(
  baseUrl: string,
  accessToken: string,
  options: { deviceId?: string; groupId?: number; fetchImpl?: Fetch } = {},
): Promise<ClaudexUsageStatus> {
  const query =
    options.groupId !== undefined ? `?group_id=${options.groupId}` : "";
  return requestJson(
    options.fetchImpl ?? fetch,
    `${baseUrl}/api/v1/claudex/usage-status${query}`,
    { token: accessToken, deviceId: options.deviceId },
  ).then(parseUsageStatus);
}

/**
 * Reads `usage-status` when the service offers it: the bootstrap's
 * `features.usage_status` when known, else by asking once (a 404 marks an
 * older service for the rest of the session).
 */
export class ClaudexUsageReader {
  private cache?: { at: number; value: ClaudexUsageStatus };
  private pending?: Promise<ClaudexUsageStatus | undefined>;
  private missing = false;
  constructor(
    private read: () => Promise<ClaudexUsageStatus>,
    /** The bootstrap's `features.usageStatus`; undefined before a bootstrap. */
    private offered: () => boolean | undefined = () => undefined,
    private now: () => number = Date.now,
  ) {}
  /** False once the service showed it has no `usage-status`. */
  get supported() {
    const offered = this.offered();
    return offered ?? !this.missing;
  }
  /** When the cached answer was read. */
  get readAt() {
    return this.cache?.at;
  }
  /** Forgets the cached answer, after a finished turn or a refusal. */
  invalidate() {
    this.cache = undefined;
  }
  /**
   * The current windows, or undefined when the service has no
   * `usage-status` (use `/subscriptions/progress`). Other failures throw.
   */
  async status(fresh = false): Promise<ClaudexUsageStatus | undefined> {
    if (!this.supported) return undefined;
    if (!fresh && this.cache && this.now() - this.cache.at < usageCacheMs)
      return this.cache.value;
    this.pending ??= this.read()
      .then((value) => {
        this.cache = { at: this.now(), value };
        return value;
      })
      .catch((error: unknown) => {
        // An older Sub2API service: no Claudex routes at all.
        if (
          error instanceof Sub2ApiError &&
          error.status === 404 &&
          this.offered() === undefined
        ) {
          this.missing = true;
          return undefined;
        }
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
