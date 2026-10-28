import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { lazyPiece } from "../../ui/lazy-piece";
import { Menu } from "../../ui/Menu";
import { Toggle } from "../../settings/controls";
import { t } from "../../i18n";
import { api } from "../../desktop-api";
import { repositoryFullName } from "../../../shared/github-api";
import type { GitHubStatus } from "../../../shared/github-api";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { Project } from "../../../shared/types";
import { repositoryRef } from "../../composer/code-repository";
import { useCloudEnvironments } from "../../composer/cloud-environments";
import { useApp } from "../../app/AppContext";
import type { RoutineDraft } from "./routine-draft";

const RepositoryMenu = lazyPiece(
  () => import("../../composer/RepositoryMenu"),
  "RepositoryMenu",
);

type Tab = "general" | "connectors" | "behavior" | "notifications";

/**
 * Advanced settings on the web: General, Connectors and Notifications as tabs.
 * General picks the repository ("Picking a repository makes this a Code
 * task."), then the project for a Chat task or the cloud environment for a Code
 * one; Connectors lists the account's connectors and goes to Settings to add
 * one; Behavior (a Code task's) lets its runs fix the pull requests they open.
 */
export function RoutineAdvancedTabs({
  draft,
  onChange,
  disabled,
  notifications,
  projects = [],
  baseMode,
}: {
  draft: RoutineDraft;
  onChange: (patch: Partial<RoutineDraft>) => void;
  disabled: boolean;
  /** The Notifications tab's rows. */
  notifications: ReactNode;
  projects?: readonly Project[];
  /** What the task is when nothing makes it a Code task. */
  baseMode: RoutineDraft["mode"];
}) {
  const [tab, setTab] = useState<Tab>("general");
  const code = draft.mode === "code";
  // Behavior is a Code task's: its runs' pull requests.
  const tabs: [Tab, string][] = [
    ["general", "General"],
    ["connectors", "Connectors"],
    ...(code ? [["behavior", "Behavior"] as [Tab, string]] : []),
    ["notifications", "Notifications"],
  ];
  const shown = tabs.some(([value]) => value === tab) ? tab : "general";
  return (
    <div className="routine-advanced-tabs">
      <div role="tablist" aria-label={t("Advanced settings")}>
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={shown === value}
            className={shown === value ? "active" : undefined}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {shown === "general" ? (
          <>
            <RepositoryRow
              draft={draft}
              disabled={disabled}
              onChange={(repository) =>
                onChange({
                  repository,
                  mode:
                    repository || draft.triggers.api || draft.triggers.github
                      ? "code"
                      : baseMode,
                  ...(repository ? { permission: "auto" as const } : {}),
                })
              }
            />
            {code ? (
              <EnvironmentRow
                draft={draft}
                disabled={disabled}
                onChange={(cloudEnvironmentId) =>
                  onChange({ cloudEnvironmentId })
                }
              />
            ) : (
              <ProjectRow
                draft={draft}
                disabled={disabled}
                projects={projects}
                onChange={(projectId) => onChange({ projectId })}
              />
            )}
          </>
        ) : shown === "connectors" ? (
          <ConnectorsTab code={code} />
        ) : shown === "behavior" ? (
          <Row
            className="routine-behavior-row"
            title="Auto-fix pull requests"
            description="Watch CI and review comments on PRs this scheduled task opens, and let Claudex push fixes."
          >
            <Toggle
              label="Auto-fix pull requests"
              checked={draft.autoFixPullRequests === true}
              disabled={disabled}
              onChange={(autoFixPullRequests) =>
                onChange({ autoFixPullRequests })
              }
            />
          </Row>
        ) : (
          notifications
        )}
      </div>
    </div>
  );
}

function Row({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`routine-setting-row ${className}`.trim()}>
      <span>
        <span className="routine-setting-title">{title}</span>
        <span className="routine-setting-description">{description}</span>
      </span>
      {children}
    </div>
  );
}

function RepositoryRow({
  draft,
  disabled,
  onChange,
}: {
  draft: RoutineDraft;
  disabled: boolean;
  onChange: (repository: RoutineDraft["repository"]) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitHubStatus>();
  useEffect(() => {
    if (!open || status) return;
    void api
      .githubStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false }));
  }, [open]);
  const name = draft.repository
    ? (repositoryFullName(draft.repository.url) ?? draft.repository.url)
    : undefined;
  return (
    <Row
      title="Repository"
      description="Picking a repository makes this a Code task."
    >
      <button
        ref={anchor}
        type="button"
        className="routine-setting-choice"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span data-no-translate={name ? true : undefined}>
          {name ?? t("None")}
        </span>
        <ChevronDown size={12} strokeWidth={1.6} />
      </button>
      {open && (
        <RepositoryMenu
          status={status}
          left={(anchor.current?.getBoundingClientRect().right ?? 0) - 320}
          anchor={anchor}
          chosen={name}
          noRepository
          onChoose={(repository) => {
            onChange(
              repository
                ? repositoryRef(
                    repository.cloneUrl,
                    repository.defaultBranch,
                    repository.defaultBranch,
                  )
                : undefined,
            );
            setOpen(false);
          }}
          onStatus={setStatus}
          onClose={() => setOpen(false)}
        />
      )}
    </Row>
  );
}

function EnvironmentRow({
  draft,
  disabled,
  onChange,
}: {
  draft: RoutineDraft;
  disabled: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const { environments } = useCloudEnvironments(() => {});
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const id = draft.cloudEnvironmentId ?? "default";
  const current = environments.find((env) => env.id === id);
  return (
    <Row
      title="Cloud environment"
      description="Permissions and network are set here"
    >
      <button
        ref={anchor}
        type="button"
        className="routine-setting-choice"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={disabled}
        onClick={() => {
          if (menu) return setMenu(undefined);
          const box = anchor.current!.getBoundingClientRect();
          setMenu({ left: box.right - 220, top: box.bottom + 6 });
        }}
      >
        <span data-no-translate>{current?.name ?? t("Default")}</span>
        <ChevronDown size={12} strokeWidth={1.6} />
      </button>
      {menu && (
        <Menu
          label="Cloud environment"
          width={220}
          position={menu}
          anchors={[anchor]}
          entries={environments.map((env) => ({
            label: env.name,
            noTranslate: true,
            checked: env.id === id,
            checkedRole: "radio" as const,
            onSelect: () => onChange(env.id === "default" ? undefined : env.id),
          }))}
          onClose={() => setMenu(undefined)}
        />
      )}
    </Row>
  );
}

function ProjectRow({
  draft,
  disabled,
  projects,
  onChange,
}: {
  draft: RoutineDraft;
  disabled: boolean;
  projects: readonly Project[];
  onChange: (id: string | undefined) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const current = projects.find((project) => project.id === draft.projectId);
  const chat = projects.filter(
    (project) => project.kind !== "code" && !project.archivedAt,
  );
  return (
    <Row title="Project" description="A project in the cloud">
      <button
        ref={anchor}
        type="button"
        className="routine-setting-choice"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={disabled}
        onClick={() => {
          if (menu) return setMenu(undefined);
          const box = anchor.current!.getBoundingClientRect();
          setMenu({ left: box.right - 240, top: box.bottom + 6 });
        }}
      >
        <AppIcon name="Folder" size={18} />
        <span data-no-translate={current ? true : undefined}>
          {current?.name ?? t("None")}
        </span>
        <ChevronDown size={12} strokeWidth={1.6} />
      </button>
      {menu && (
        <Menu
          label="Project"
          width={240}
          position={menu}
          anchors={[anchor]}
          entries={[
            {
              label: "None",
              checked: !current,
              checkedRole: "radio" as const,
              onSelect: () => onChange(undefined),
            },
            ...chat.map((project) => ({
              label: project.name,
              noTranslate: true,
              checked: project.id === draft.projectId,
              checkedRole: "radio" as const,
              onSelect: () => onChange(project.id),
            })),
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </Row>
  );
}

/** The account's connectors a task can use; Settings adds more. */
function ConnectorsTab({ code }: { code: boolean }) {
  const app = useApp();
  const [servers, setServers] = useState<McpServerState[]>();
  useEffect(() => {
    let live = true;
    void window.desktop
      .mcpServers()
      .then((value) => live && setServers(value.servers))
      .catch(() => live && setServers([]));
    return () => {
      live = false;
    };
  }, []);
  const connected = (servers ?? []).filter(
    (server) => server.state !== "disabled",
  );
  const add = (
    <button
      type="button"
      className="secondary routine-connectors-add"
      onClick={() => app.openSettingsTab("connectors")}
    >
      {code ? t("Add connector") : t("Add connectors")}
    </button>
  );
  if (servers && !connected.length)
    return (
      <div className="routine-connectors-empty">
        <strong>{t("No connectors connected")}</strong>
        <span>
          {t("Add connectors in Settings to use them in your tasks.")}
        </span>
        {add}
      </div>
    );
  return (
    <div className="routine-connectors">
      {code && (
        <p className="routine-setting-description">
          {t(
            "In a Code task, Claudex can use these connectors without asking.",
          )}
        </p>
      )}
      <ul>
        {connected.map((server) => (
          <li key={server.name} data-no-translate>
            <AppIcon name="Connectors" size={16} />
            {server.displayName ?? server.name}
          </li>
        ))}
      </ul>
      {add}
    </div>
  );
}
