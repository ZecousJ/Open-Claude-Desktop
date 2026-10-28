import { useEffect, useRef, useState } from "react";
import { formatText, useT } from "../i18n";
import { Button, SettingsModal } from "./controls";

/** Import confirmation and result copy. */
export function CliImportDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(busy);
  busyNow.current = busy;
  const [result, setResult] = useState<{ imported: number; skipped: number }>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError(false);
    void window.desktop.probeImportableCliSessions().then(
      (value) => {
        if (current) setCount(value.count);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);
  return (
    <SettingsModal
      title="Import Claudex Code sessions"
      variant="confirm"
      onClose={() => {
        if (!busyNow.current) onClose();
      }}
    >
      <div aria-live="polite">
        {error ? (
          t("Couldn’t import sessions")
        ) : result ? (
          <>
            <p>
              {result.imported
                ? formatText(
                    result.imported === 1
                      ? "Imported 1 session"
                      : "Imported {count} sessions",
                    { count: result.imported },
                  )
                : t("No sessions imported")}
            </p>
            {result.imported > 0 && (
              <p>
                {t(
                  result.imported === 1
                    ? "Find it in your session list."
                    : "Find them in your session list.",
                )}
              </p>
            )}
          </>
        ) : busy ? (
          t("Importing sessions")
        ) : count === undefined ? (
          t("Looking for sessions on this computer…")
        ) : count === 0 ? (
          <>
            <p>{t("No sessions to import")}</p>
            <p>
              {t(
                "Only sessions in your trusted folders can be imported, and there are none left to add.",
              )}
            </p>
          </>
        ) : (
          formatText(
            count === 1
              ? "Found 1 session. Choose whether to import it."
              : "Found {count} sessions. Choose whether to import them.",
            { count },
          )
        )}
      </div>
      <footer>
        <Button disabled={busy} onClick={onClose}>
          {result ? "Done" : "Cancel"}
        </Button>
        {error ? (
          <Button
            onClick={() => {
              setResult(undefined);
              setCount(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        ) : (
          !result &&
          !!count && (
            <Button
              primary
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void window.desktop
                  .importAllCliSessions()
                  .then(setResult, () => setError(true))
                  .finally(() => setBusy(false));
              }}
            >
              Import
            </Button>
          )
        )}
      </footer>
    </SettingsModal>
  );
}
