import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion } from "../ui/usePresence";
import type { Mode } from "../../shared/types";
import { useAnnouncements } from "./Announcements";
import { usePolicy } from "./PolicyContext";
import {
  dismissUpdate,
  openUpdateDownload,
  useDismissedUpdate,
} from "./UpdateNotice";
import { GlobalLimitToast } from "./GlobalLimitToast";
import "./global-limit-toast.css";
import { NoticeView } from "./NoticeView";
import { useWeeklyUsage } from "./useWeeklyUsage";
import { useLowBalance } from "./useLowBalance";
import { AppContext } from "../app/AppContext";
import { openRecharge } from "../settings/billing/recharge";
import { lazyPiece } from "../ui/lazy-piece";
import { limitDialogKey, useLimitDialog } from "./limit-reached";
import {
  relaunchReady,
  selfUpdating,
  useAppUpdate,
} from "../updates/useAppUpdate";
import { useRelaunchFlow } from "../updates/RelaunchToUpdate";
import {
  announcementNotice,
  balanceNotice,
  lowBalanceDue,
  noticeOrder,
  noticeSurface,
  updateNotice,
  usageNotice,
  type ComposerNoticeKind,
  type ComposerNoticeVariant,
  type NoticeContent,
} from "./notice-content";

const LimitReachedDialog = lazyPiece(
  () => import("./LimitReachedDialog"),
  "LimitReachedDialog",
);

export type {
  ComposerNoticeKind,
  ComposerNoticeVariant,
} from "./notice-content";

export interface ComposerNoticeProps {
  /** usage | service | rate-limit | announcement | update | balance (notice-content.ts). */
  kind: ComposerNoticeKind;
  /** home | conversation | narrow (a side panel narrows the conversation). */
  variant: ComposerNoticeVariant;
  /** The surface: Chat and Cowork share a frame, Code has its own. */
  mode: Mode;
}

/** Everything the notices read, loaded once for however many are shown. */
function useNotices(
  kinds: readonly ComposerNoticeKind[],
  mode: Mode,
  onError: (error: unknown) => void,
) {
  const surface = noticeSurface(mode);
  const policy = usePolicy();
  const announcements = useAnnouncements();
  const dismissedUpdate = useDismissedUpdate();
  const usage = useWeeklyUsage();
  const appUpdate = useAppUpdate();
  const relaunchFlow = useRelaunchFlow(onError);
  // The balance and its recharge entry belong to service accounts.
  const app = useContext(AppContext);
  const remote = !!app?.remoteAccount;
  const balance = useLowBalance(
    remote && kinds.includes("balance"),
    app?.accountEmail || undefined,
  );
  const recharge = app?.openSettingsTab
    ? () => openRecharge(() => app.openSettingsTab("billing"))
    : undefined;
  // The limit-hit dialog, once per limit window, where a usage notice shows.
  const canAddFunds = remote && balance.canAddFunds && !!recharge;
  const limitDialog = useLimitDialog(
    kinds.includes("usage") || kinds.includes("service")
      ? limitDialogKey(usage.status, canAddFunds)
      : null,
  );
  const notices: {
    content: NoticeContent;
    onAction?: () => void;
    onSecondary?: () => void;
    onDismiss?: () => void;
  }[] = [];
  for (const kind of noticeOrder.filter((item) => kinds.includes(item))) {
    if (kind === "usage" || kind === "service") {
      const content = usageNotice(usage.status, kind, surface, canAddFunds);
      const url = usage.status?.moreUsageUrl;
      const notify = window.desktop.notifyWhenUsageResets;
      if (content)
        notices.push({
          content,
          onAction:
            content.action?.kind === "add-funds"
              ? recharge
              : url
                ? () => void window.desktop.openExternal(url).catch(onError)
                : undefined,
          // The main process answers with a "weekly-usage" event too.
          onSecondary: notify
            ? () => void Promise.resolve(notify()).catch(onError)
            : undefined,
          onDismiss: usage.dismiss,
        });
    } else if (kind === "balance") {
      if (
        balance.balance !== null &&
        lowBalanceDue(balance.balance, balance.dismissed, usage.status)
      )
        notices.push({
          content: balanceNotice(
            balance.balance,
            surface,
            balance.canAddFunds && !!recharge,
          ),
          onAction: recharge,
          onDismiss: balance.dismiss,
        });
    } else if (kind === "announcement") {
      const content = announcementNotice(announcements.unread);
      const notice = announcements.unread.find((item) => item.popup);
      if (content && notice)
        notices.push({
          content,
          onAction: announcements.open,
          onDismiss: () => announcements.markRead([notice.id]),
        });
    } else if (kind === "update") {
      const content = updateNotice(policy.update, dismissedUpdate);
      const update = policy.update;
      // Claudex fetching or holding the update itself: Relaunch instead of the
      // download page, nothing while it downloads.
      const self = selfUpdating(appUpdate, update);
      if (content && update)
        notices.push({
          content: self
            ? {
                ...content,
                action: relaunchReady(appUpdate)
                  ? { kind: "download", label: "Relaunch" }
                  : undefined,
              }
            : content,
          onAction: self
            ? relaunchFlow.relaunch
            : () => openUpdateDownload(onError),
          onDismiss: () => dismissUpdate(update.latestVersion),
        });
    }
    // "rate-limit": the corner notice below (GlobalLimitToast) shows it.
  }
  const status = usage.status;
  const limit =
    limitDialog.open && status
      ? (() => {
          const addFunds = canAddFunds && status.reason === "balance";
          const url = status.moreUsageUrl;
          return {
            status,
            addFunds,
            onAction: addFunds
              ? recharge!
              : () => {
                  if (url) void window.desktop.openExternal(url).catch(onError);
                },
            onClose: limitDialog.close,
          };
        })()
      : null;
  return { surface, notices, limit, relaunchDialog: relaunchFlow.dialog };
}

/**
 * A notice above the composer. It reads its own data: the usage status, the
 * administrator's announcements or the policy's update, and renders nothing
 * when there is nothing to say.
 */
export function ComposerNotice({
  kind,
  variant,
  mode,
  onError = () => {},
}: ComposerNoticeProps & { onError?: (error: unknown) => void }) {
  return (
    <ComposerNotices
      kinds={[kind]}
      variant={variant}
      mode={mode}
      onError={onError}
    />
  );
}

/**
 * Every notice that applies, stacked in `noticeOrder` (update first, usage
 * last), and the window's corner notice for a session or rate limit, which one
 * mounted composer places at the window's corner.
 */
export function ComposerNotices({
  kinds = noticeOrder,
  variant,
  mode,
  onError = () => {},
}: {
  kinds?: readonly ComposerNoticeKind[];
  variant: ComposerNoticeVariant;
  mode: Mode;
  onError?: (error: unknown) => void;
}) {
  const { surface, notices, limit, relaunchDialog } = useNotices(
    kinds,
    mode,
    onError,
  );
  const shown = useLeaving(
    notices,
    (notice) => notice.content.kind,
    noticeExitMs,
  );
  return (
    <>
      {shown.map(({ item: notice, leaving }) => (
        // Each notice opens its row over 300ms and slides up 8px into it; a
        // notice that goes closes its row again.
        <div
          key={notice.content.kind}
          className="composer-notice-slot"
          data-state={leaving ? "closed" : "open"}
          inert={leaving || undefined}
        >
          <div>
            <NoticeView
              content={notice.content}
              surface={surface}
              variant={variant}
              onAction={notice.onAction}
              onSecondary={notice.onSecondary}
              onDismiss={notice.onDismiss}
            />
          </div>
        </div>
      ))}
      <GlobalLimitToast />
      {limit && <LimitReachedDialog {...limit} />}
      {relaunchDialog}
    </>
  );
}

/** A notice's row closes in 300ms. */
const noticeExitMs = 300;

/**
 * The list as shown: the current items, and for `exitMs` after it left each
 * item that is no longer there, in its old place and marked leaving. Under
 * reduced motion an item goes at once.
 */
export function useLeaving<T>(
  items: readonly T[],
  key: (item: T) => string,
  exitMs: number,
): { item: T; leaving: boolean }[] {
  type Entry = { key: string; item: T; index: number };
  const [leaving, setLeaving] = useState<Entry[]>([]);
  // The items the last commit showed, for the copy a leaving one keeps.
  const committed = useRef(items);
  const keys = items.map(key).join("\n");
  const [shownKeys, setShownKeys] = useState(keys);
  // Worked out while rendering, so a notice that went is never unmounted
  // and mounted again: React renders once more before it commits.
  if (shownKeys !== keys) {
    setShownKeys(keys);
    const now = new Set(items.map(key));
    const gone = committed.current
      .map((item, index) => ({ key: key(item), item, index }))
      .filter((entry) => !now.has(entry.key));
    setLeaving((list) =>
      prefersReducedMotion()
        ? []
        : [...list.filter((entry) => !now.has(entry.key)), ...gone],
    );
  }
  useLayoutEffect(() => {
    committed.current = items;
  });
  const leavingKeys = leaving.map((entry) => entry.key).join("\n");
  useEffect(() => {
    if (!leaving.length) return;
    const timer = setTimeout(() => {
      const done = new Set(leaving.map((entry) => entry.key));
      setLeaving((list) => list.filter((entry) => !done.has(entry.key)));
    }, exitMs);
    return () => clearTimeout(timer);
  }, [leavingKeys, exitMs]);
  const shown = items.map((item) => ({ item, leaving: false }));
  for (const entry of [...leaving].sort((a, b) => a.index - b.index))
    if (!items.some((item) => key(item) === entry.key))
      shown.splice(Math.min(entry.index, shown.length), 0, {
        item: entry.item,
        leaving: true,
      });
  return shown;
}
