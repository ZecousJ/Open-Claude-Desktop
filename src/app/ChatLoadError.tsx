import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { EmptyState } from "../ui/EmptyState";
import "./chat-load-error.css";

// V3 conversation recovery.
export function ChatLoadError({
  session = false,
  onRetry,
}: {
  session?: boolean;
  onRetry: () => void | Promise<unknown>;
}) {
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && !navigator.onLine,
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retry = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await onRetry();
    } catch {
      // A failed request stays in this recoverable load state.
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [onRetry]);
  useEffect(() => {
    const online = () => {
      setOffline(false);
      void retry();
    };
    const disconnected = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", disconnected);
    };
  }, [retry]);
  return (
    <div className="chat-load-error">
      <EmptyState
        pictogram="ObjectAlert"
        headline={
          <span role={busy ? undefined : "alert"}>
            {t(
              session
                ? "Couldn’t load this session"
                : "Couldn’t load this chat",
            )}
          </span>
        }
        description={
          offline ? (
            <span role="alert">
              {t("You’re offline. It will load once you’re back online.")}
            </span>
          ) : undefined
        }
        ctaLabel={t("Try again")}
        ctaBusy={busy}
        ctaBusyLabel={t("Loading")}
        onCtaClick={() => void retry()}
      />
    </div>
  );
}
