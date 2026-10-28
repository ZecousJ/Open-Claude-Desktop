import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { GlobalLimitNotice } from "../../shared/usage-api";
import { AppContext } from "../app/AppContext";
import { useT } from "../i18n";
import { useNoticeStack } from "../ui/notice-stack";
import { CloseSmallIcon } from "../ui/icons";
import { AppIcon } from "../ui/app-icon";
import { globalLimitKey, globalLimitText } from "./notice-content";
import { useWeeklyUsage } from "./useWeeklyUsage";

/** Where a closed notice is remembered, so the same reset does not show it again. */
const dismissedKey = "claudex.globalLimitToast.dismissed";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(dismissedKey);
  } catch {
    return null;
  }
}
function writeDismissed(key: string) {
  try {
    window.localStorage.setItem(dismissedKey, key);
  } catch {
    // Kept for this window only.
  }
}

/** How long the main process holds a notice the service gave no reset time for. */
const unknownResetHoldMs = {
  session: 5 * 60 * 60 * 1000,
  "rate-limit": 60 * 1000,
} as const;

/**
 * Only one mounted notice shows (several composers can be mounted at
 * once); the first to mount owns the window's corner.
 */
const owners: symbol[] = [];
const ownerListeners = new Set<() => void>();
function claimCorner(owner: symbol) {
  owners.push(owner);
  for (const listener of ownerListeners) listener();
  return () => {
    owners.splice(owners.indexOf(owner), 1);
    for (const listener of ownerListeners) listener();
  };
}
function subscribeOwners(listener: () => void) {
  ownerListeners.add(listener);
  return () => void ownerListeners.delete(listener);
}

/**
 * The window's corner notice when the service's 5-hour session limit or its
 * request rate limit refused a request. Closing it hides it until the limit is
 * hit again with another reset time.
 */
export function GlobalLimitToast() {
  const [owner] = useState(() => Symbol("global-limit-toast"));
  useEffect(() => claimCorner(owner), [owner]);
  const first = useSyncExternalStore(
    subscribeOwners,
    () => owners[0],
    () => owners[0],
  );
  const { status } = useWeeklyUsage();
  const app = useContext(AppContext);
  const [closed, setClosed] = useState(readDismissed);
  const notice = status?.globalLimit;
  const [expired, setExpired] = useState<GlobalLimitNotice | null>(null);
  /** A closed notice without a reset time: a later refusal shows again. */
  const [closedUnknown, setClosedUnknown] = useState<GlobalLimitNotice | null>(
    null,
  );
  // The status is refreshed at the banner's reset, which can be days after
  // this limit's: the notice hides itself once its own limit has reset (or,
  // without a reset time, once the main process stops holding it). Each
  // status the main process sends is a new notice, so a later refusal
  // shows again.
  useEffect(() => {
    if (!notice) return;
    const wait = Math.min(
      notice.resetsAt
        ? notice.resetsAt - Date.now()
        : unknownResetHoldMs[notice.kind],
      2 ** 31 - 1,
    );
    if (wait <= 0) return void setExpired(notice);
    const timer = setTimeout(() => setExpired(notice), wait);
    return () => clearTimeout(timer);
  }, [notice]);
  if (first !== owner || !notice || expired === notice) return null;
  if (closedUnknown === notice) return null;
  const key = globalLimitKey(notice);
  if (closed === key) return null;
  const openUsage =
    app?.remoteAccount && app.openSettingsTab
      ? () => app.openSettingsTab("usage")
      : undefined;
  return createPortal(
    <GlobalLimitView
      notice={notice}
      onViewUsage={openUsage}
      onDismiss={() => {
        // A known reset stays closed until the next one; an unknown one
        // only until the service refuses again.
        if (notice.resetsAt) {
          setClosed(key);
          writeDismissed(key);
        } else setClosedUnknown(notice);
      }}
    />,
    document.body,
  );
}

/** The notice itself (fixtures and tests render it directly). */
export function GlobalLimitView({
  notice,
  onViewUsage,
  onDismiss,
}: {
  notice: GlobalLimitNotice;
  onViewUsage?: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useNoticeStack(ref);
  return (
    <div
      ref={ref}
      className="global-limit-toast"
      role="alert"
      data-limit={notice.kind}
    >
      <WarningIcon />
      <p className="global-limit-toast-text">
        {t(globalLimitText(notice))}
        {onViewUsage && (
          <>
            {"  "}
            <button
              type="button"
              className="global-limit-toast-link"
              onClick={onViewUsage}
            >
              {t("View your usage details")}
            </button>
            .
          </>
        )}
      </p>
      <button
        type="button"
        className="global-limit-toast-close"
        aria-label={t("Dismiss")}
        onClick={onDismiss}
      >
        <CloseSmallIcon />
      </button>
    </div>
  );
}

// Warning family.
export function WarningIcon({ size = 16 }: { size?: number }) {
  return (
    <AppIcon name="Warning" size={size} className="global-limit-toast-icon" />
  );
}
