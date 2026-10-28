import { Check } from "../ui/glyphs";
import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { AppEnvironment } from "../../shared/app-update-api";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { codeEffortLabels } from "../../shared/code-effort";
import {
  permissionModeOf,
  permissionModeTitles,
} from "../../shared/client-policy";
import { useApp } from "../app/AppContext";
import { useModelCatalog } from "../composer/useComposerServices";
import { modelLabel } from "../composer/model/code-model-choices";
import { useConversationServices } from "../conversation/ConversationServices";
import { currentLocale, formatText, t, tc, useT } from "../i18n";
import { fastModeState } from "../composer/code/code-fast-mode";
import { AppIcon } from "../ui/app-icon";
import {
  sessionInfoGroups,
  sessionInfoReport,
  type InfoRow,
} from "./session-info-model";
import "./session-info.css";

/** A copy button that turns into a check for two seconds. */
function CopyButton({
  label,
  className,
  text,
}: {
  label: string;
  className: string;
  text: () => string;
}) {
  const services = useConversationServices();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const shown = copied ? "Copied" : label;
  return (
    <button
      type="button"
      className={className}
      aria-label={t(shown)}
      title={t(shown)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() =>
        void services.copyText(text()).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <AppIcon name="Copy" />
      )}
    </button>
  );
}

function Row({ row, onManageMcp }: { row: InfoRow; onManageMcp?: () => void }) {
  return (
    <div className="session-info-row">
      <span className="session-info-label">{t(row.label)}</span>
      <span className="session-info-end">
        <span className="session-info-values">
          <span
            className={`session-info-value${row.id === "sessionId" ? " mono" : ""}`}
            title={row.fullValue ?? row.value}
          >
            {row.id === "sandbox" ? tc("state", row.value) : row.value}
          </span>
          {row.hint && <span className="session-info-hint">{row.hint}</span>}
        </span>
        {row.id === "mcp" && onManageMcp && (
          <button
            type="button"
            className="session-info-manage"
            onClick={onManageMcp}
          >
            {t("Manage")}
          </button>
        )}
        {row.copyable && (
          <CopyButton
            label="Copy session ID"
            className="session-info-copy small"
            text={() => row.fullValue ?? row.value}
          />
        )}
      </span>
    </div>
  );
}

/**
 * The Session info card /status posts in a Code transcript. See
 * session-info-model.ts for the rows.
 */
export function SessionInfoCard({
  conversation,
}: {
  conversation: Conversation;
}) {
  useT();
  const app = useApp();
  const catalog = useModelCatalog();
  const [environment, setEnvironment] = useState<AppEnvironment>();
  const [mcp, setMcp] = useState<McpServerState[]>();
  const [sshHost, setSshHost] = useState<string>();
  const ssh =
    conversation.environment?.kind === "ssh"
      ? conversation.environment.hostId
      : undefined;
  useEffect(() => {
    let live = true;
    const api = window.desktop;
    void Promise.resolve(api?.appEnvironment?.())
      .then((value) => live && value && setEnvironment(value))
      .catch(() => undefined);
    void Promise.resolve(api?.mcpServers?.())
      .then((value) => live && value && setMcp(value.servers))
      .catch(() => undefined);
    if (ssh)
      void Promise.resolve(api?.sshListHosts?.())
        .then((value) => {
          const host = value?.hosts.find((item) => item.id === ssh);
          if (live && host) setSshHost(host.label || host.destination);
        })
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ssh]);
  const settings = app.snapshot.settings;
  const mode = permissionModeOf(settings, conversation.cwd);
  const project = app.snapshot.projects.find(
    (p) => p.id === conversation.projectId,
  );
  const fast = fastModeState(catalog, conversation.model);
  const effortLabel =
    codeEffortLabels[settings.codeEffort] ?? settings.codeEffort;
  const groups = useMemo(
    () =>
      sessionInfoGroups({
        conversation,
        environment,
        // A fast tier reads as its model with "{effort} · Fast".
        model: modelLabel(catalog, fast.on ? fast.target : conversation.model),
        effort: fast.on
          ? formatText("{effort} · Fast", { effort: t(effortLabel) })
          : t(effortLabel),
        permissions: t(permissionModeTitles[mode]),
        sandboxOn: mode !== "bypass",
        sshHost,
        additionalFolders:
          conversation.additionalFolders ?? project?.additionalFolders,
        mcp,
        account: app.accountEmail,
        when: (ms) =>
          new Intl.DateTimeFormat(currentLocale(), {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(ms),
      }).map((group) => ({ ...group, label: t(group.label) })),
    [
      conversation,
      environment,
      catalog,
      settings,
      mode,
      sshHost,
      project,
      mcp,
      app.accountEmail,
    ],
  );
  return (
    <div className="session-info-card" data-testid="session-info-card">
      <span className="session-info-head">
        <span>{t("Session info")}</span>
        <CopyButton
          label="Copy session info"
          className="session-info-copy"
          text={() =>
            sessionInfoReport(
              groups.map((group) => ({
                ...group,
                rows: group.rows.map((row) => ({
                  ...row,
                  label: t(row.label),
                })),
              })),
              new Date().toISOString(),
            )
          }
        />
      </span>
      {!environment && (
        <p className="session-info-loading" role="status">
          {t("Loading session info…")}
        </p>
      )}
      <div className="session-info-groups">
        {groups.map((group) => (
          <div key={group.id} className="session-info-group">
            <span className="session-info-group-label">{group.label}</span>
            <div className="session-info-rows">
              {group.rows
                .filter((row) => !row.reportOnly)
                .map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    onManageMcp={() => app.openSettingsTab("connectors")}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
