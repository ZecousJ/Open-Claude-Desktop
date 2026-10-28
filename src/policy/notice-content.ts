import type { Mode, WeeklyUsageStatus } from "../../shared/types";
import type { Announcement, ClientUpdate } from "../../shared/client-policy";
import type { GlobalLimitNotice, LimitReason } from "../../shared/usage-api";
import { updateBlocksSending } from "../../shared/client-release";
import { downloadPage } from "../../shared/external-links";
import { bannerText } from "../composer/usageBanner";
import { formatText, t } from "../i18n";
import { lowBalanceUsd } from "../../shared/billing-api";
import { usd } from "../settings/billing/quote";

/**
 * What a notice above the composer is about:
 * - usage: the plan's usage windows (warning, or a limit reached);
 * - service: the account itself cannot use the service (plan not active,
 *   balance used up, the device's own cap);
 * - rate-limit: kept for the frozen interface; the service's session and
 *   request rate limits show as the window's corner notice (GlobalLimitToast),
 *   not above the composer, so this kind shows nothing;
 * - balance: the account's balance is below $10, in the usage warning's frame
 *   with Add funds;
 * - announcement: the newest unread popup notice from the administrator;
 * - update: a required update (an available one is shown above the account).
 */
export type ComposerNoticeKind =
  "usage" | "service" | "rate-limit" | "announcement" | "update" | "balance";
/**
 * Where the notice sits: above the home composer, above a conversation's
 * composer, or above a conversation's composer narrowed by a side panel.
 */
export type ComposerNoticeVariant = "home" | "conversation" | "narrow";
/** Chat and Cowork share the outlined frame; Code has the filled strip. */
export type NoticeSurface = "chat" | "code";

/** The order notices stack in when several apply. */
export const noticeOrder: ComposerNoticeKind[] = [
  "update",
  "service",
  "rate-limit",
  "announcement",
  "balance",
  "usage",
];

export const noticeSurface = (mode: Mode): NoticeSurface =>
  mode === "code" ? "code" : "chat";

export type NoticeAction =
  | "more-usage"
  | "add-funds"
  | "read"
  | "download"
  | "notify"
  | "retry"
  | "continue";
export interface NoticeContent {
  /** "sleep": a Code session's sleep band (src/code-sleep/SleepBand.tsx). */
  kind: ComposerNoticeKind | "sleep" | "workflow";
  /** Class for colour: the usage state, or the notice's own. */
  tone: "warning" | "exceeded" | "announcement" | "update" | "required";
  icon: "gauge" | "info" | "download" | "coffee";
  title: string;
  detail?: string;
  /** A button before the main action: Get notified. */
  secondary?: { kind: NoticeAction; label: string; disabled?: boolean };
  action?: { kind: NoticeAction; label: string; disabled?: boolean };
  dismissible: boolean;
  role: "status" | "alert";
}

/** Refusals about the account rather than a usage window. */
const accountReasons: LimitReason[] = ["key-quota", "balance", "subscription"];

/** Which kind a usage status belongs to, or null when no banner is due. */
export function usageNoticeKind(
  status: WeeklyUsageStatus | null | undefined,
): "usage" | "service" | null {
  if (!status || status.state === "ok" || status.dismissed) return null;
  return status.state === "exceeded" &&
    status.reason &&
    accountReasons.includes(status.reason)
    ? "service"
    : "usage";
}

/**
 * `canAddFunds`: this account can recharge in the app, so "Your balance is
 * used up" offers Add funds (the recharge entry) instead of the
 * administrator's Get more usage page.
 */
export function usageNotice(
  status: WeeklyUsageStatus | null | undefined,
  kind: "usage" | "service",
  surface: NoticeSurface,
  canAddFunds = false,
): NoticeContent | null {
  if (!status || usageNoticeKind(status) !== kind) return null;
  const text = bannerText(status, surface);
  const addFunds =
    canAddFunds && status.state === "exceeded" && status.reason === "balance";
  return {
    kind,
    tone: status.state === "exceeded" ? "exceeded" : "warning",
    icon: surface === "code" && kind === "usage" ? "gauge" : "info",
    ...text,
    // Only when this computer can show the notification, and until asked.
    ...(status.state === "exceeded" && status.resetNotification === "available"
      ? { secondary: { kind: "notify" as const, label: "Get notified" } }
      : {}),
    action: addFunds
      ? { kind: "add-funds", label: "Add funds" }
      : status.moreUsageUrl
        ? { kind: "more-usage", label: "Get more usage" }
        : undefined,
    dismissible: true,
    role: "status",
  };
}

/**
 * Whether the balance warning is due: the balance is known, below
 * `lowBalanceUsd` and not closed, and the service is not already refusing
 * requests for it ("Your balance is used up" says so then).
 */
export function lowBalanceDue(
  balance: number | null | undefined,
  dismissed: boolean,
  status: WeeklyUsageStatus | null | undefined,
) {
  if (balance === null || balance === undefined || dismissed) return false;
  if (!(balance < lowBalanceUsd)) return false;
  return !(
    status &&
    status.state === "exceeded" &&
    status.reason === "balance" &&
    !status.dismissed
  );
}

/**
 * The balance warning, in the usage warning's frame with the balance's words:
 * Chat and Cowork give what is left, Code a title and the amount under it. Add
 * funds opens the recharge entry when this account can recharge in the app.
 */
export function balanceNotice(
  balance: number,
  surface: NoticeSurface,
  canAddFunds: boolean,
): NoticeContent {
  const amount = usd(Math.max(0, balance));
  return {
    kind: "balance",
    tone: "warning",
    icon: surface === "code" ? "gauge" : "info",
    ...(surface === "code"
      ? {
          title: "Balance running low",
          detail: `${amount} left in your balance`,
        }
      : { title: `You have ${amount} left in your balance` }),
    action: canAddFunds ? { kind: "add-funds", label: "Add funds" } : undefined,
    dismissible: true,
    role: "status",
  };
}

/** "9:30 AM" in the viewer's local time, as R-0314's corner notice reads. */
export function formatResetClock(resetsAt: number) {
  return (
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })
      .format(new Date(resetsAt))
      // Kept on one line, as R-0314 wraps before "9:30 AM.", never inside it.
      .replace(/\s+(?=[AP]M$)/, " ")
  );
}

/**
 * The corner notice's sentence: the session limit in the original's words, the
 * request rate limit in the same shape. The link ("View your usage details.")
 * is added by the notice when it can open Settings → Usage.
 */
export function globalLimitText(notice: GlobalLimitNotice) {
  const at = notice.resetsAt ? formatResetClock(notice.resetsAt) : null;
  // The rate limit reads as the original's "Too many requests right now. Try
  // again in a moment."; the session limit's reset clause is its "Limits will
  // reset at {resetsAt}."
  if (notice.kind === "rate-limit")
    return at
      ? formatText("Too many requests right now. Try again at {at}.", { at })
      : t("Too many requests right now. Try again in a moment.");
  return at
    ? formatText(
        "You’ve hit your limit for Claudex messages. Limits will reset at {at}.",
        { at },
      )
    : t("You’ve hit your limit for Claudex messages.");
}

/** One notice per reset: closed, it stays closed until the limit is hit again. */
export function globalLimitKey(notice: GlobalLimitNotice) {
  return `${notice.kind}:${notice.resetsAt ?? "unknown"}`;
}

export function announcementNotice(
  unread: Announcement[],
): NoticeContent | null {
  const notice = unread.find((item) => item.popup);
  if (!notice) return null;
  return {
    kind: "announcement",
    tone: "announcement",
    icon: "info",
    title: notice.title,
    action: { kind: "read", label: "Read" },
    dismissible: true,
    role: "status",
  };
}

/**
 * A required update. When the service enforces it the composer cannot send
 * and the notice stays; otherwise it can be put away for this version.
 */
export function updateNotice(
  update: ClientUpdate | undefined,
  dismissedVersion: string,
): NoticeContent | null {
  if (!update || update.state !== "required") return null;
  const blocks = updateBlocksSending(update);
  if (!blocks && dismissedVersion === update.latestVersion) return null;
  return {
    kind: "update",
    tone: blocks ? "required" : "update",
    icon: "download",
    title: blocks
      ? "Update required"
      : `Update to Claudex ${update.latestVersion}`,
    detail: blocks
      ? `Install Claudex ${update.latestVersion} to keep working.`
      : "This version is no longer supported.",
    action: downloadPage(update)
      ? { kind: "download", label: "Download" }
      : undefined,
    dismissible: !blocks,
    role: blocks ? "alert" : "status",
  };
}
