import { useState } from "react";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import { formatText, useT } from "../../i18n";
import { AppIcon } from "../../ui/app-icon";
import "../../composer/auth-issue.css";
import "./connector-attention.css";

export function connectorsNeedingAttention(servers: McpServerState[]) {
  return servers.filter(
    (server) =>
      server.state !== "disabled" &&
      (server.state === "failed" || server.authStatus === "notLoggedIn"),
  );
}

const hiddenKey = "claudex.connectors.attentionHidden";

/** The connectors the person hid the banner for; a new broken one shows it again. */
function readHidden() {
  try {
    return localStorage.getItem(hiddenKey) ?? "";
  } catch {
    return "";
  }
}

// The warning Banner with its icon, a View action and a dismiss.
export default function ConnectorAttention({
  servers,
  editable,
  busy,
  onReconnect,
  onView,
}: {
  servers: McpServerState[];
  editable: boolean;
  busy: boolean;
  onReconnect: () => void;
  /** View: opens the first connector that needs attention. */
  onView?: (server: McpServerState) => void;
}) {
  const t = useT();
  const [hidden, setHidden] = useState(readHidden);
  const attention = connectorsNeedingAttention(servers);
  const expired = attention.filter(
    (server) => server.authStatus === "notLoggedIn",
  );
  const key = attention
    .map((server) => server.name)
    .sort()
    .join("\n");
  if (!attention.length || hidden === key) return null;
  return (
    <div role="status" className="connector-attention">
      <div
        className="auth-issue-banner"
        data-cds="Banner"
        data-variant="warning"
      >
        <span className="auth-issue-icon">
          <AppIcon name="Warning" />
        </span>
        <span className="auth-issue-copy">
          {formatText(
            attention.length === 1
              ? "1 of your connectors needs attention"
              : "{count} of your connectors need attention",
            { count: attention.length },
          )}
        </span>
        {onView && (
          <button
            type="button"
            className="settings-button"
            onClick={() => onView(attention[0])}
          >
            View
          </button>
        )}
        {editable && expired.length > 0 && (
          <button
            type="button"
            className="settings-button"
            disabled={busy}
            aria-label={formatText(
              expired.length === 1
                ? "Reconnect all 1 connector whose sign-in expired"
                : "Reconnect all {count} connectors whose sign-in expired",
              { count: expired.length },
            )}
            onClick={onReconnect}
          >
            Reconnect all
          </button>
        )}
        <span className="auth-issue-dismiss-slot">
          <button
            type="button"
            className="auth-issue-dismiss"
            aria-label={t("Dismiss")}
            onClick={() => {
              setHidden(key);
              try {
                localStorage.setItem(hiddenKey, key);
              } catch {
                /* the banner stays hidden until this window closes */
              }
            }}
          >
            <AppIcon name="X" />
          </button>
        </span>
      </div>
    </div>
  );
}
