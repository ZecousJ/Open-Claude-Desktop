/**
 * Where a Sub2API account's usage comes from (design 4.2 item 8). Package
 * C2 made the seam and keeps today's behaviour (subscription progress and
 * the device key's own caps); package C4 owns this file after C2 and adds
 * the Claudex `usage-status` source behind the same interface.
 */
import type {
  PlanUsage,
  Provider,
  WeeklyUsageStatus,
} from "../../shared/types";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { WeeklyDismissal } from "../conversations/weekly-usage";
import type { KeyStore } from "./backend";
import type {
  PublicSettings,
  SubscriptionProgress,
  Sub2ApiClient,
} from "./client";
import type { PlanChoice } from "./provision";
import {
  blockedStatus,
  blockFor,
  planWindows,
  selectProgress,
  weeklyFromKeyUsage,
  weeklyFromProgress,
  type BannerPolicy,
  type LimitBlock,
} from "./quota";
import type { RemoteSession } from "./session";

export interface UsageSource {
  /** Settings → Usage: the plan's windows; `fresh` skips the short cache. */
  planUsage(warnPercent: number, fresh: boolean): Promise<PlanUsage | null>;
  /** The weekly banner above the composer, exceeded while a refusal holds. */
  weeklyStatus(
    policy: BannerPolicy,
    dismissal: WeeklyDismissal | undefined,
    keys: KeyStore,
  ): Promise<WeeklyUsageStatus | null>;
  /** A gateway refusal: an exceeded limit holds the banner until it resets. */
  recordRefusal(refusal: GatewayRefusal): void;
  /** A reply went through, so no limit is refusing requests any more. */
  clearRefusal(): void;
  /** The refusal the banner holds now, if any. */
  readonly refusal: GatewayRefusal | undefined;
}

/** What the usage source reads from the signed-in account. */
export interface UsageContext {
  readonly client: Sub2ApiClient;
  readonly session: RemoteSession;
  publicSettings(): Promise<PublicSettings>;
  plan(): PlanChoice | undefined;
  provider(): Provider | undefined;
  /** The device key when it is not in the vault. */
  sessionKey(): string;
}

const progressCacheMs = 15_000;

/** Today's behaviour: Sub2API subscription progress, else the key's own 7-day cap. */
export class SubscriptionUsage implements UsageSource {
  private block?: LimitBlock;
  private progressCache?: { at: number; value: SubscriptionProgress[] };
  constructor(
    private context: UsageContext,
    private now: () => number = Date.now,
  ) {}
  recordRefusal(refusal: GatewayRefusal) {
    if (!refusal.exceeded) return;
    this.block = blockFor(
      refusal,
      this.progressCache &&
        selectProgress(this.progressCache.value, this.context.plan()?.groupId),
      this.now(),
    );
    this.progressCache = undefined;
  }
  clearRefusal() {
    this.block = undefined;
    this.progressCache = undefined;
  }
  get refusal() {
    if (this.block && this.block.until <= this.now()) this.block = undefined;
    return this.block?.refusal;
  }
  async progress(fresh = false) {
    if (
      !fresh &&
      this.progressCache &&
      this.now() - this.progressCache.at < progressCacheMs
    )
      return this.progressCache.value;
    const value = await this.context.session.authorized((token) =>
      this.context.client.subscriptionProgress(token),
    );
    this.progressCache = { at: this.now(), value };
    return value;
  }
  async weeklyStatus(
    policy: BannerPolicy,
    dismissal: WeeklyDismissal | undefined,
    keys: KeyStore,
  ): Promise<WeeklyUsageStatus | null> {
    const entry = selectProgress(
      await this.progress().catch(() => []),
      this.context.plan()?.groupId,
    );
    let base = weeklyFromProgress(entry?.weekly, policy, dismissal);
    const provider = this.context.provider();
    if (!base && provider) {
      const reply = await keys
        .remote(provider, "usage", this.context.sessionKey())
        .catch(() => undefined);
      if (reply?.ok && reply.body)
        try {
          base = weeklyFromKeyUsage(
            JSON.parse(reply.body),
            policy,
            this.now(),
            dismissal,
          );
        } catch {
          base = null;
        }
    }
    if (this.refusal && this.block)
      return blockedStatus(base, this.block, policy, dismissal);
    return base;
  }
  async planUsage(
    warnPercent: number,
    fresh: boolean,
  ): Promise<PlanUsage | null> {
    const plan = this.context.plan();
    if (!plan) return null;
    const entry = selectProgress(await this.progress(fresh), plan.groupId);
    const settings = await this.context.publicSettings().catch(() => undefined);
    const doc = settings?.docUrl ?? "";
    return {
      plan: entry?.groupName || plan.name,
      expiresAt: entry?.expiresAt ?? plan.expiresAt,
      windows: entry ? planWindows(entry) : [],
      updatedAt: this.progressCache?.at ?? this.now(),
      warnPercent,
      learnMoreUrl: /^https:\/\//.test(doc) ? doc : null,
    };
  }
}
