import { useEffect, useState } from "react";
import type { McpLogSnapshot } from "../../shared/settings-mcp-api";
import { Button, SettingsModal } from "./controls";
import { formatText, t } from "../i18n";
import {
  useSettingsRequestScope,
  type SettingsScopeOwner,
} from "./useSettingsRequestScope";
import "./settings-mcp.css";

/** Separates runtime connection events from positively attributed native stderr. */
type McpLogsDialogProps = { name: string; onClose(): void };
export function McpLogsDialog(props: McpLogsDialogProps) {
  const scope = useSettingsRequestScope();
  return <ScopedMcpLogsDialog key={scope.key} {...props} scope={scope} />;
}
function ScopedMcpLogsDialog({
  name,
  onClose,
  scope,
}: McpLogsDialogProps & { scope: SettingsScopeOwner }) {
  const [snapshot, setSnapshot] = useState<McpLogSnapshot>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const request = scope.capture();
    if (!request.current() || !request.bridge) return;
    setLoading(true);
    setFailed(false);
    void request.bridge
      .readMcpLogs(name)
      .then((value) => {
        if (active && request.current()) setSnapshot(value);
      })
      .catch(() => {
        if (active && request.current()) setFailed(true);
      })
      .finally(() => {
        if (active && request.current()) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [name, revision, scope.key]);
  return (
    <SettingsModal
      title={formatText("MCP logs: {name}", { name })}
      onClose={() => {
        if (scope.capture().current()) onClose();
      }}
    >
      <p className="settings-mcp-note">
        {snapshot?.serverOutput?.availability === "available"
          ? "Server stderr captured on this computer. Credentials are redacted before storage; older logs are rotated."
          : "Connection events from the current runtime. Server stderr is not available. Credentials are redacted and older events are discarded when the limit is reached."}
      </p>
      {loading && <p role="status">Loading logs…</p>}
      {failed && (
        <p role="alert">Couldn’t load this server’s logs. Try again.</p>
      )}
      {!loading && !failed && snapshot && (
        <>
          {snapshot.serverOutput && (
            <section aria-label={t("Server stderr")}>
              <h3>Server stderr</h3>
              {snapshot.serverOutput.availability === "pending" ? (
                <p role="status">Waiting for this server’s stderr capture.</p>
              ) : snapshot.serverOutput.availability !== "available" ? (
                <p role="status">
                  Server stderr capture is unavailable for this configuration.
                </p>
              ) : snapshot.serverOutput.lines.length ? (
                <pre
                  className="settings-mcp-log"
                  aria-label={t("MCP server stderr")}
                >
                  {snapshot.serverOutput.lines.join("\n")}
                </pre>
              ) : (
                <p role="status">
                  No stderr has been captured for this server yet.
                </p>
              )}
              {snapshot.serverOutput.truncated && (
                <p role="status">Showing the most recent server output.</p>
              )}
            </section>
          )}
          {snapshot.serverOutput && <h3>Connection events</h3>}
          {snapshot.truncated && (
            <p role="status">Showing the most recent events.</p>
          )}
          {snapshot.lines.length ? (
            <pre
              className="settings-mcp-log"
              aria-label="MCP connection events"
            >
              {snapshot.lines.join("\n")}
            </pre>
          ) : (
            <p role="status">
              No connection events have been captured for this server yet.
            </p>
          )}
        </>
      )}
      <div className="button-row">
        <Button
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </Button>
        <Button
          onClick={() => {
            if (scope.capture().current()) onClose();
          }}
        >
          Done
        </Button>
      </div>
    </SettingsModal>
  );
}
