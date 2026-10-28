import { useContext, useState } from "react";
import { AppIcon } from "../../ui/app-icon";
import type { TaskConnectionHold } from "../../../shared/task-connection-hold";
import { taskConnectionHoldMessage } from "../../../shared/task-connection-hold";
import { formatText, t } from "../../i18n";
import { AppContext } from "../../app/AppContext";

// Sign-in recovery.
export function ConnectionHold({
  hold,
  onRun,
  disabled,
}: {
  hold: TaskConnectionHold;
  onRun: () => void;
  disabled: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const app = useContext(AppContext);
  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (hold.url) await window.desktop.openExternal(hold.url);
      else {
        const address = await window.desktop.connectConnector(
          hold.service,
          app?.host?.kind === "web"
            ? new URL(location.pathname, location.origin).href
            : undefined,
        );
        if (address) await window.desktop.openExternal(address);
      }
      setOpened(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="routine-connection-hold" role="status">
      <AppIcon name="Warning" size={16} aria-hidden="true" />
      <div className="routine-connection-hold-copy">
        <p>{t(taskConnectionHoldMessage)}</p>
        {hold.url && (
          <p>
            {formatText("Its sign-in page is at {host}.", {
              host: new URL(hold.url).host,
            })}
          </p>
        )}
        <div role="group" aria-label={t("Connect and run")}>
          {(hold.url || hold.service) && (
            <button
              className="secondary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void connect()}
            >
              {opened
                ? t("Reopen URL")
                : hold.service
                  ? formatText("Connect {service}", { service: hold.service })
                  : t("Connect")}
            </button>
          )}
          {opened && (
            <button className="secondary" disabled={disabled} onClick={onRun}>
              Run now
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
