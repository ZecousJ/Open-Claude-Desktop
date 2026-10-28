import { useEffect, useState } from "react";
import type {
  LocalMcpDiscovery,
  LocalMcpImportResult,
} from "../../shared/settings-mcp-api";
import { localMcpImportLimit } from "../../shared/settings-mcp-api";
import { usePolicy } from "../policy/PolicyContext";
import { formatText } from "../i18n";
import { Button, SettingsModal } from "./controls";
import {
  useSettingsRequestScope,
  type SettingsScopeOwner,
} from "./useSettingsRequestScope";
import "./settings-mcp.css";

/** Fixed local sources, redacted previews, and an explicit selection before writing. */
export function LocalMcpImportDialog(props: { onClose(): void }) {
  const scope = useSettingsRequestScope();
  return (
    <ScopedLocalMcpImportDialog key={scope.key} {...props} scope={scope} />
  );
}
function ScopedLocalMcpImportDialog({
  onClose,
  scope,
}: {
  onClose(): void;
  scope: SettingsScopeOwner;
}) {
  const policy = usePolicy();
  const [discovery, setDiscovery] = useState<LocalMcpDiscovery>();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LocalMcpImportResult>();
  useEffect(() => {
    let active = true;
    const request = scope.capture();
    if (!request.current() || !request.bridge) return;
    setDiscovery(undefined);
    setSelected([]);
    setError(undefined);
    void request.bridge
      .discoverLocalMcp()
      .then((value) => {
        if (active && request.current()) setDiscovery(value);
      })
      .catch(() => {
        if (active && request.current())
          setError("Couldn’t check local MCP configurations. Try again.");
      });
    return () => {
      active = false;
    };
  }, [revision, scope.key]);
  const submit = async () => {
    const request = scope.capture();
    if (!request.current() || !request.bridge) return;
    if (!discovery || !selected.length || busy || !policy.localMcpEditing)
      return;
    setBusy(true);
    setError(undefined);
    try {
      const imported = await request.bridge.importLocalMcp({
        token: discovery.token,
        ids: selected,
      });
      if (request.current()) setResult(imported);
    } catch (failure) {
      if (request.current())
        setError(
          failure instanceof Error
            ? failure.message
            : "Couldn’t import these servers. Check again and retry.",
        );
    } finally {
      if (request.current()) setBusy(false);
    }
  };
  return (
    <SettingsModal
      title="Import local MCP servers"
      onClose={() => {
        if (!busy && scope.capture().current()) onClose();
      }}
    >
      {result ? (
        <p role="status">
          {formatText(
            result.imported.length === 1
              ? "Imported {count} server. They are disabled. Review and enable them in Developer → Edit config when you trust their commands."
              : "Imported {count} servers. They are disabled. Review and enable them in Developer → Edit config when you trust their commands.",
            { count: result.imported.length },
          )}
        </p>
      ) : (
        <>
          <h3 className="settings-mcp-heading">Local MCP servers</h3>
          <p className="settings-mcp-note settings-mcp-review-description">
            Review servers from Claude Desktop, Claude Code user settings and
            Cursor user settings on this computer. Only supported local stdio
            configurations are offered. Environment credentials are preserved
            during import and hidden in this preview.
          </p>
          <p className="settings-mcp-note">
            MCP commands can access local files and services with your account’s
            permissions when enabled. Selected servers will be added disabled.
            Existing servers and their credentials are preserved.
          </p>
          {!discovery && !error && (
            <p role="status">Checking local configurations…</p>
          )}
          {discovery && (
            <>
              <ul
                className="settings-mcp-sources"
                aria-label="Checked MCP sources"
              >
                {discovery.sources.map((source) => (
                  <li key={source.name}>
                    {source.name}:{" "}
                    {source.state === "read"
                      ? "Checked"
                      : source.state === "missing"
                        ? "Not found"
                        : "Couldn’t read"}
                    {source.message && <p>{source.message}</p>}
                  </li>
                ))}
              </ul>
              {!discovery.candidates.length && (
                <p role="status">
                  No local MCP servers found in supported sources.
                </p>
              )}
              <div className="settings-mcp-candidates">
                {discovery.candidates.map((candidate) => (
                  <div className="settings-mcp-candidate" key={candidate.id}>
                    <label>
                      <input
                        className="cx-check-input"
                        type="checkbox"
                        checked={selected.includes(candidate.id)}
                        disabled={
                          busy ||
                          candidate.state !== "available" ||
                          (!selected.includes(candidate.id) &&
                            selected.length >= localMcpImportLimit) ||
                          !policy.localMcpEditing
                        }
                        onChange={(event) =>
                          setSelected((value) =>
                            event.target.checked
                              ? [...value, candidate.id]
                              : value.filter((id) => id !== candidate.id),
                          )
                        }
                      />
                      <span>
                        {candidate.name} <small>— {candidate.source}</small>
                      </span>
                    </label>
                    {candidate.reason && <p>{candidate.reason}</p>}
                    {candidate.preview && (
                      <details>
                        <summary>Review command and environment</summary>
                        <pre>{candidate.preview}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
              <p role="status">
                {formatText(
                  "{count} selected. You can add up to {limit} at a time.",
                  { count: selected.length, limit: localMcpImportLimit },
                )}
              </p>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {!policy.localMcpEditing && (
        <p role="alert">Your administrator has turned off local MCP editing.</p>
      )}
      <div className="button-row">
        {!result && (
          <Button
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            Check again
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={() => {
            if (scope.capture().current()) onClose();
          }}
        >
          {result ? "Done" : "Cancel"}
        </Button>
        {!result && (
          <Button
            primary
            disabled={
              !discovery || !selected.length || busy || !policy.localMcpEditing
            }
            onClick={() => void submit()}
          >
            {busy
              ? "Importing…"
              : formatText(
                  selected.length === 1
                    ? "Import {count} disabled server"
                    : "Import {count} disabled servers",
                  { count: selected.length },
                )}
          </Button>
        )}
      </div>
    </SettingsModal>
  );
}
