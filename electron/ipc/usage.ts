import { requestJson } from "../sub2api/http";
import type { ProductUsage } from "../../shared/usage-api";
import electron from "electron";
import { z } from "zod";
import type { Conversation } from "../../shared/types";
import type {
  GlobalLimitNotice,
  PlanUsage,
  WeeklyUsageStatus,
} from "../../shared/usage-api";
import type {
  BootstrapSource,
  GatewayRefusalDetails,
} from "../../shared/claudex-contract";
import type { GlobalLimitKind } from "../../server/sub2api-errors";
import { type ClientPolicy } from "../../shared/client-policy";
import { administratorUrls, urlListed } from "../../shared/client-policy-rules";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { RemoteHost } from "../remote/host";
import { remoteBannerPolicy } from "../account/remote-mode";
import {
  ClaudexUsageReader,
  fetchUsageStatus,
  planUsageFromStatus,
} from "../sub2api/claudex-usage";
import { deviceId } from "../sub2api/provision";
import {
  blockedStatus,
  blockFor,
  weeklyFromUsageStatus,
  type LimitBlock,
  type TimedRefusal,
} from "../sub2api/quota";
import { planWindowsFromStatus } from "../../shared/plan-usage";
import {
  dismissWeeklyUsage,
  readDismissal,
  readWeeklyUsage,
  saveDismissal,
} from "../conversations/weekly-usage-status";

/**
 * The banner offers Get more usage only when the page can open: external
 * links are on, or the policy names the page (openExternal's rule).
 */
export function withOpenableLink(
  status: WeeklyUsageStatus | null,
  policy: ClientPolicy,
): WeeklyUsageStatus | null {
  const url = status?.moreUsageUrl;
  if (!status || !url || policy.externalLinks) return status;
  return urlListed(url, administratorUrls(policy))
    ? status
    : { ...status, moreUsageUrl: null };
}

/**
 * The account's bootstrap, once the remote host carries one (package C2's
 * `BootstrapSource`); before that the reader asks the service directly.
 */
function bootstrapOf(remote: RemoteHost): BootstrapSource | undefined {
  const source = (remote as { bootstrap?: unknown }).bootstrap;
  return source &&
    typeof (source as Partial<BootstrapSource>).current === "function"
    ? (source as BootstrapSource)
    : undefined;
}

const readers = new WeakMap<RemoteHost, ClaudexUsageReader>();
/** One `usage-status` reader per signed-in remote account. */
export function usageReader(ctx: AppContext, remote: RemoteHost) {
  let reader = readers.get(remote);
  if (!reader) {
    reader = new ClaudexUsageReader(
      () =>
        remote.session.authorized((token) =>
          fetchUsageStatus(remote.accounts.baseUrl, token, {
            deviceId: deviceId(ctx.dataRoot),
            groupId: remote.backend.plan?.groupId,
          }),
        ),
      () => bootstrapOf(remote)?.current()?.features.usageStatus,
    );
    readers.set(remote, reader);
  }
  return reader;
}

const heldBlocks = new WeakMap<object, LimitBlock>();
/**
 * How long a refusal holds the banner, worked out once per refusal so a
 * refusal without `resets_at` keeps the end it got when first seen instead
 * of moving a week ahead on every read.
 */
function heldBlock(refusal: TimedRefusal, now: number) {
  let block = heldBlocks.get(refusal);
  if (!block) {
    block = blockFor(refusal, undefined, now);
    heldBlocks.set(refusal, block);
  }
  return block;
}

/**
 * The banner's status with the window-wide limit notice and the Get notified
 * offer.
 */
export async function currentWeeklyUsage(
  ctx: AppContext,
): Promise<WeeklyUsageStatus | null> {
  const status = await bannerWeeklyUsage(ctx);
  const account = ctx.activeAccount;
  if (!account) return status;
  const remote = ctx.remote;
  return withResetNotification(
    remote
      ? withGlobalLimit(status, currentGlobalLimit(remote), ctx.policy())
      : status,
    account.id,
  );
}

/** The Claudex service's windows, else Sub2API's plan windows, else the local usage log. */
async function bannerWeeklyUsage(
  ctx: AppContext,
): Promise<WeeklyUsageStatus | null> {
  const account = ctx.activeAccount;
  if (!account) return null;
  const remote = ctx.remote;
  const policy = ctx.policy();
  if (!remote)
    return withOpenableLink(
      readWeeklyUsage(ctx.dataRoot, account.id, ctx.store.root),
      policy,
    );
  const banner = await remoteBannerPolicy(policy, remote.accounts);
  const dismissal = readDismissal(ctx.store.root);
  const usage = await usageReader(ctx, remote)
    .status(false)
    .catch(() => undefined);
  if (!usage)
    return withOpenableLink(
      await remote.backend.weeklyStatus(banner, dismissal, ctx.credentials),
      policy,
    );
  const now = Date.now();
  const base = weeklyFromUsageStatus(
    usage,
    planWindowsFromStatus(usage),
    banner,
    now,
    dismissal,
  );
  // A refusal since the last read keeps the banner exceeded until its reset.
  const refusal = remote.backend.refusal;
  return withOpenableLink(
    refusal
      ? blockedStatus(base, heldBlock(refusal, now), banner, dismissal)
      : base,
    policy,
  );
}

/** How long a notice holds without a reset time from the service. */
const globalLimitHoldMs = {
  session: 5 * 60 * 60 * 1000,
  "rate-limit": 60 * 1000,
} as const;
interface GlobalLimitHold {
  kind: GlobalLimitKind;
  resetsAt: number | null;
  until: number;
}
const globalLimits = new WeakMap<RemoteHost, GlobalLimitHold>();

/**
 * A refusal called for R-0127's window-wide notice (the 5-hour session or
 * the request rate limit): it holds until the reset the service named, or
 * a while without one, or until a reply goes through.
 */
export function holdGlobalLimit(
  remote: RemoteHost,
  kind: GlobalLimitKind,
  refusal: Pick<GatewayRefusalDetails, "resetsAt">,
  now = Date.now(),
) {
  const resetsAt =
    refusal.resetsAt && refusal.resetsAt > now ? refusal.resetsAt : null;
  globalLimits.set(remote, {
    kind,
    resetsAt,
    until: resetsAt ?? now + globalLimitHoldMs[kind],
  });
}

/** The notice the window shows now, if a refusal still holds one. */
export function currentGlobalLimit(
  remote: RemoteHost,
  now = Date.now(),
): GlobalLimitNotice | undefined {
  const hold = globalLimits.get(remote);
  if (!hold) return undefined;
  if (hold.until <= now) {
    globalLimits.delete(remote);
    return undefined;
  }
  return { kind: hold.kind, resetsAt: hold.resetsAt };
}

/**
 * The status with the global notice added. Without a banner status (no
 * windows to show) a quiet "ok" status carries the notice alone, so the
 * banner stays hidden while the corner notice shows.
 */
export function withGlobalLimit(
  status: WeeklyUsageStatus | null,
  notice: GlobalLimitNotice | undefined,
  policy: ClientPolicy,
  now = Date.now(),
): WeeklyUsageStatus | null {
  if (!notice) return status;
  if (status) return { ...status, globalLimit: notice };
  return {
    used: 0,
    limit: 0,
    percent: 0,
    warnPercent: policy.usageBanner.warnPercent,
    resetsAt: notice.resetsAt ?? now + globalLimitHoldMs[notice.kind],
    moreUsageUrl: null,
    state: "ok",
    dismissed: false,
    globalLimit: notice,
  };
}

/** Scheduled "Get notified" reminders, one per account. */
const resetReminders = new Map<
  string,
  { resetsAt: number; timer: NodeJS.Timeout }
>();
/** Longest wait setTimeout takes; longer waits are chained. */
const maxTimerMs = 2 ** 31 - 1;
/** Resets further away than this are not offered a reminder. */
const maxReminderMs = 31 * 24 * 60 * 60 * 1000;

/** Electron's system notifications, when this process can show them. */
function systemNotifications() {
  const Notification = (
    electron as { Notification?: typeof Electron.Notification }
  ).Notification;
  try {
    return Notification?.isSupported() ? Notification : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the exceeded banner offers Get notified, and whether it was used. */
export function withResetNotification(
  status: WeeklyUsageStatus | null,
  accountId: string,
  now = Date.now(),
  supported = !!systemNotifications(),
): WeeklyUsageStatus | null {
  if (
    !status ||
    !supported ||
    status.state !== "exceeded" ||
    status.resetsAt <= now ||
    status.resetsAt - now > maxReminderMs
  )
    return status;
  const reminder = resetReminders.get(accountId);
  return {
    ...status,
    resetNotification:
      reminder?.resetsAt === status.resetsAt ? "scheduled" : "available",
  };
}

/**
 * Get notified: a system notification when the limit resets, for the
 * account that asked (another account signed in by then hears nothing).
 */
export function scheduleResetReminder(
  ctx: Pick<AppContext, "activeAccount">,
  accountId: string,
  resetsAt: number,
  now = Date.now(),
  show = (title: string, body: string) => {
    const Notification = systemNotifications();
    if (Notification) new Notification({ title, body }).show();
  },
) {
  if (resetsAt <= now || resetsAt - now > maxReminderMs) return false;
  const previous = resetReminders.get(accountId);
  if (previous?.resetsAt === resetsAt) return true;
  if (previous) clearTimeout(previous.timer);
  const arm = (): NodeJS.Timeout => {
    const wait = Math.min(Math.max(resetsAt - Date.now(), 0), maxTimerMs);
    const timer = setTimeout(() => {
      if (resetsAt > Date.now()) {
        resetReminders.set(accountId, { resetsAt, timer: arm() });
        return;
      }
      resetReminders.delete(accountId);
      if (ctx.activeAccount?.id !== accountId) return;
      show(
        "Claudex",
        "Your usage limit has reset. You can send messages again.",
      );
    }, wait);
    timer.unref?.();
    return timer;
  };
  resetReminders.set(accountId, { resetsAt, timer: arm() });
  return true;
}

/**
 * After the account's balance or plan changed outside this app (the
 * a top-up on the web): the refusal held from the empty
 * balance is dropped, the plan and its models are read again, and the
 * window hears of the new models and usage, so "Your balance is used up"
 * and "Model service unavailable" go away by themselves.
 */
export async function refreshAccountState(ctx: AppContext) {
  const remote = ctx.remote;
  if (!remote) return;
  remote.clearRefusal();
  usageReader(ctx, remote).invalidate();
  await remote.refreshPlan();
  ctx.push({ type: "service-changed" });
  await pushWeeklyUsage(ctx);
}

/** Tells the window the banner's current state; an unreadable source hides it. */
export async function pushWeeklyUsage(ctx: AppContext) {
  let status: WeeklyUsageStatus | null = null;
  let unavailable = false;
  try {
    status = await currentWeeklyUsage(ctx);
  } catch {
    // An unreadable policy, usage log or service hides the banner; files are left untouched.
    unavailable = true;
  }
  ctx.push({
    type: "weekly-usage",
    status,
    ...(unavailable ? { unavailable: true as const } : {}),
  });
}

/** Settings → Usage: the plan, its windows and the Learn more page. */
export async function currentPlanUsage(
  ctx: AppContext,
  fresh: boolean,
): Promise<PlanUsage | null> {
  const remote = ctx.remote;
  if (!remote) return null;
  const policy = ctx.policy();
  const warnPercent = policy.usageBanner.warnPercent;
  const learnMore = policy.links.usageLearnMore ?? null;
  const usage = await usageReader(ctx, remote).status(fresh);
  if (usage)
    return planUsageFromStatus(usage, {
      plan: policy.planLabel ?? remote.backend.planName,
      expiresAt: remote.backend.plan?.expiresAt ?? null,
      warnPercent,
      learnMoreUrl: learnMore,
      readAt: usageReader(ctx, remote).readAt ?? Date.now(),
    });
  const legacy = await remote.backend.planUsage(warnPercent, fresh);
  return (
    legacy && {
      ...legacy,
      plan: policy.planLabel ?? legacy.plan,
      learnMoreUrl: learnMore ?? legacy.learnMoreUrl,
    }
  );
}

/**
 * Watches the engine's conversation events so a finished turn refreshes the
 * weekly usage banner; a reply that went through also clears a refusal the
 * banner was holding.
 */
export function weeklyUsageTurns(ctx: AppContext) {
  const inProgress = new Set<string>();
  return {
    observe(conversation: Conversation) {
      const running = conversation.turns.some((t) => t.status === "inProgress");
      if (running) return void inProgress.add(conversation.id);
      if (!inProgress.delete(conversation.id) || !ctx.activeAccount) return;
      // The turn used some of the plan: read the windows again.
      if (ctx.remote) usageReader(ctx, ctx.remote).invalidate();
      // A reply that went through means the service is no longer refusing.
      if (conversation.turns.at(-1)?.status === "completed" && ctx.remote) {
        ctx.remote.clearRefusal();
        globalLimits.delete(ctx.remote);
      }
      void pushWeeklyUsage(ctx);
    },
    clear() {
      inProgress.clear();
    },
  };
}

/** Plan usage limits (Settings → Usage) and the weekly usage banner. */
export function registerUsageHandlers(handle: IpcHandle, ctx: AppContext) {
  handle("weeklyUsageStatus", () => currentWeeklyUsage(ctx));
  handle("dismissWeeklyUsage", async (raw: unknown) => {
    const seen = z.enum(["ok", "warning", "exceeded"]).parse(raw);
    return ctx.remote
      ? saveDismissal(ctx.store.root, await currentWeeklyUsage(ctx), seen)
      : withOpenableLink(
          dismissWeeklyUsage(
            ctx.dataRoot,
            ctx.activeAccount!.id,
            ctx.store.root,
            Date.now(),
            seen,
          ),
          ctx.policy(),
        );
  });
  handle("usageProducts", async (raw: unknown = "7") => {
    const range = z.enum(["7", "30", "month", "yesterday"]).parse(raw);
    const remote = ctx.remote;
    if (!remote?.ready) return null;
    try {
      const body = (await remote.session.authorized((token) =>
        requestJson(
          fetch,
          `${remote.accounts.baseUrl}/api/v1/claudex/usage-products?days=${range}`,
          { token },
        ),
      )) as Record<string, unknown> | undefined;
      return productUsageFrom(body);
    } catch {
      // An older service has no usage by product: nothing is shown.
      return null;
    }
  });
  handle("planUsage", async (fresh: unknown = false) =>
    currentPlanUsage(ctx, z.boolean().parse(fresh)),
  );
  handle("notifyWhenUsageResets", async () => {
    const status = await currentWeeklyUsage(ctx);
    const account = ctx.activeAccount;
    // Only the reset the banner shows, and only when it offers the button.
    if (!account || !status?.resetNotification) return status;
    scheduleResetReminder(ctx, account.id, status.resetsAt);
    const next = withResetNotification(status, account.id);
    // Every notice reading the status hides its Get notified button.
    ctx.push({ type: "weekly-usage", status: next });
    return next;
  });
}

const productKeys = ["code", "cowork", "chat", "other"] as const;
const costsOf = (value: unknown) => {
  const out: Partial<Record<(typeof productKeys)[number], number>> = {};
  if (value && typeof value === "object")
    for (const key of productKeys) {
      const n = (value as Record<string, unknown>)[key];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
    }
  return out;
};
/** The service's usage-products answer, checked. */
export function productUsageFrom(
  body: Record<string, unknown> | undefined,
): ProductUsage | null {
  if (!body || typeof body !== "object") return null;
  const days = Array.isArray(body.days) ? body.days : [];
  return {
    from: typeof body.from === "string" ? body.from : "",
    to: typeof body.to === "string" ? body.to : "",
    totals: costsOf(body.totals),
    requests: costsOf(body.requests),
    days: days
      .filter(
        (day): day is Record<string, unknown> =>
          Boolean(day) && typeof day === "object",
      )
      .map((day) => ({
        day: typeof day.day === "string" ? day.day : "",
        costUsd: costsOf(day.cost_usd),
      })),
  };
}
