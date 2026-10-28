import { useEffect, useRef, useState } from "react";
import type { SshToolGrant } from "../../shared/ssh-api";
import { formatText } from "../i18n";
import { Trash2 } from "../ui/glyphs";
import { SettingsModal } from "../settings/controls";
import { useApp } from "../app/AppContext";
import "./tool-grants.css";

// Shared allowed-sites card, no add field.
export function SshToolGrantsDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [grants, setGrants] = useState<SshToolGrant[]>([]);
  const [pending, setPending] = useState<string>();
  const alive = useRef(true);
  const done = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    alive.current = true;
    void window.desktop
      .sshToolGrants()
      .then((entries) => {
        if (alive.current) setGrants(entries);
      })
      .catch(app.report);
    return () => {
      alive.current = false;
    };
  }, [app.report]);
  const change = async (key: string, action: () => Promise<void>) => {
    setPending(key);
    try {
      await action();
      const entries = await window.desktop.sshToolGrants();
      if (alive.current) {
        setGrants(entries);
        requestAnimationFrame(() => {
          if (!alive.current) return;
          const keys = grants.map((grant) =>
            JSON.stringify([grant.endpointKey, grant.server, grant.toolName]),
          );
          const index = keys.indexOf(key);
          const remaining = new Set(
            entries.map((grant) =>
              JSON.stringify([grant.endpointKey, grant.server, grant.toolName]),
            ),
          );
          const next = [
            ...keys.slice(index + 1),
            ...keys.slice(0, index).reverse(),
          ].find((entry) => remaining.has(entry));
          (next ? buttons.current.get(next) : done.current)?.focus();
        });
      }
    } catch (error) {
      app.report(error);
    } finally {
      if (alive.current) setPending(undefined);
    }
  };
  return (
    <SettingsModal
      title="Allowed connector tools"
      className="ssh-tool-grants"
      onClose={onClose}
    >
      <p className="ssh-tool-grants-description">
        Claudex can use each tool on the SSH host shown beside it without a
        permission prompt. Remove one and Claudex asks again next time.
      </p>
      <div className="ssh-tool-grants-list">
        {grants.map((grant) => {
          const key = JSON.stringify([
            grant.endpointKey,
            grant.server,
            grant.toolName,
          ]);
          const label = formatText("{tool} ({server})", {
            tool: grant.toolLabel,
            server: grant.serverLabel,
          });
          return (
            <div key={key}>
              <span data-no-translate title={label}>
                {label}
              </span>
              <small data-no-translate title={grant.hostLabel}>
                {grant.hostLabel}
              </small>
              <button
                type="button"
                disabled={Boolean(pending)}
                ref={(element) => {
                  if (element) buttons.current.set(key, element);
                  else buttons.current.delete(key);
                }}
                aria-label={formatText("Remove {tool} on {host}", {
                  tool: label,
                  host: grant.hostLabel,
                })}
                onClick={() =>
                  void change(key, () =>
                    window.desktop.sshRemoveToolGrant(
                      grant.endpointKey,
                      grant.server,
                      grant.toolName,
                    ),
                  )
                }
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {!grants.length && (
          <p>
            Nothing here yet. When you choose “Always allow” for a connector
            tool in an SSH session, it appears here.
          </p>
        )}
      </div>
      <div className="button-row">
        <button
          type="button"
          className="primary danger-button"
          disabled={!grants.length || Boolean(pending)}
          onClick={() =>
            void change("all", () => window.desktop.sshClearToolGrants())
          }
        >
          Clear all
        </button>
        <button
          type="button"
          ref={done}
          className="primary"
          disabled={pending === "all"}
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </SettingsModal>
  );
}
