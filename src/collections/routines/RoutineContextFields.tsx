import { SegmentedControl } from "../../ui/SegmentedControl";
import { AppIcon } from "../../ui/app-icon";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Project } from "../../../shared/types";
import type { RoutineCapabilities } from "../../../shared/routines";
import { projectKind } from "../../../shared/project-kind";
import { useHost } from "../../host/HostContext";
import { AppContext } from "../../app/AppContext";
import { t } from "../../i18n";
import type { RoutineDraft } from "./routine-draft";
import "./routine-context-fields.css";

export type RoutineSurface = "chat" | "code";

/** Sources come from the scheduler, not the availability of a Code composer. */
export function useRoutineSources(location: RoutineDraft["executionLocation"]) {
  const app = useContext(AppContext);
  const account = app?.accountId;
  const owner = app?.controllerScope;
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const [result, setResult] = useState<{
    location: typeof location;
    bridge: typeof bridge;
    account: typeof account;
    owner: typeof owner;
    sources: readonly RoutineSurface[];
  }>();
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    let revision = 0;
    const load = () => {
      const request = ++revision;
      void Promise.resolve()
        .then(() => bridge.routineCapabilities(location))
        .then((value: RoutineCapabilities) => {
          if (live && request === revision)
            setResult({
              location,
              bridge,
              account,
              owner,
              sources: Array.isArray(value.sources)
                ? [
                    ...new Set(
                      value.sources.filter(
                        (source) => source === "chat" || source === "code",
                      ),
                    ),
                  ]
                : [],
            });
        })
        .catch(() => {
          if (live && request === revision)
            setResult({ location, bridge, account, owner, sources: [] });
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [location, bridge, account, owner]);
  return result &&
    result.location === location &&
    result.bridge === bridge &&
    result.account === account &&
    result.owner === owner
    ? result.sources
    : [];
}

/** The captured edit branch has no selector. Project-bound creation keeps its source. */
export function RoutineSourcePicker({
  draft,
  sources,
  onChange,
  disabled = false,
}: {
  draft: RoutineDraft;
  sources: readonly RoutineSurface[];
  onChange: (patch: Partial<RoutineDraft>) => void;
  disabled?: boolean;
}) {
  // O16 c97:1384–1390: unified Chat entry has no surface switch; Code entry may offer it.
  const initialSurface = useRef(draft.mode);
  if (draft.id || sources.length < 2 || initialSurface.current !== "code")
    return null;
  const source = draft.mode === "code" ? "code" : "chat";
  return (
    <SegmentedControl
      className="routine-source-picker"
      label={t("Task type")}
      value={source}
      disabled={disabled}
      segments={sources.map((value) => ({
        value,
        label: t(value === "chat" ? "Chat" : "Code"),
        icon: <AppIcon name={value === "chat" ? "Chats" : "Code"} size={16} />,
        disabled:
          Boolean(draft.projectId || draft.securityReview) && value !== source,
      }))}
      onChange={(value) =>
        onChange({ mode: value === "chat" ? "cowork" : "code" })
      }
    />
  );
}

export function routineProjects(
  draft: RoutineDraft,
  projects: readonly Project[],
  localFolders: boolean,
) {
  return projects.filter((project) => {
    if (project.archivedAt) return false;
    const kind = projectKind(project);
    if ((draft.mode === "code") !== (kind === "code")) return false;
    // A remote runner cannot use paths belonging to this computer. SSH and
    // isolated-space project binding require their own scheduler capability.
    if (project.environment && project.environment.kind !== "local")
      return false;
    return (
      !project.cwd || (localFolders && draft.executionLocation !== "remote")
    );
  });
}

/** Optional context is retained even when this host cannot offer its picker. */
export function RoutineContextFields({
  draft,
  projects = [],
  onChange,
  onChooseFolder,
  disabled = false,
}: {
  draft: RoutineDraft;
  projects?: readonly Project[];
  onChange: (patch: Partial<RoutineDraft>) => void;
  onChooseFolder?: () => Promise<string | null>;
  disabled?: boolean;
}) {
  const host = useHost();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const latest = useRef({ draft, disabled, onChange, host });
  latest.current = { draft, disabled, onChange, host };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const local = host.kind === "desktop" && draft.executionLocation !== "remote";
  const folders =
    local &&
    host.capabilities.localFolders &&
    Boolean(onChooseFolder) &&
    (!draft.environment || draft.environment.kind === "local");
  const choices = local
    ? routineProjects(draft, projects, host.capabilities.localFolders)
    : [];
  const selected = projects.find((project) => project.id === draft.projectId);
  return (
    <>
      {(draft.projectId || (!draft.id && choices.length > 0)) && (
        <label className="routine-context-field">
          <span>{t("Project")}</span>
          <select
            aria-label={t("Project")}
            value={draft.projectId ?? ""}
            disabled={disabled || Boolean(draft.id)}
            onChange={(event) => {
              const project = choices.find(
                (project) => project.id === event.target.value,
              );
              onChange({
                projectId: project?.id,
                cwd: project?.cwd,
                environment: project?.environment,
                ...(project?.cwd
                  ? { executionLocation: "local" as const }
                  : {}),
              });
            }}
          >
            <option value="">{t("None")}</option>
            {selected &&
              !choices.some((project) => project.id === selected.id) && (
                <option value={selected.id}>{selected.name}</option>
              )}
            {draft.projectId && !selected && (
              <option value={draft.projectId}>{draft.projectId}</option>
            )}
            {choices.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(folders || draft.cwd) && (
        <div className="routine-context-field">
          <span>{t("Folder")}</span>
          {draft.cwd && (
            <span className="routine-context-path" data-no-translate>
              {draft.cwd}
            </span>
          )}
          {folders && !draft.projectId && (
            <div className="routine-context-actions">
              <button
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => {
                  setError(undefined);
                  const current = latest.current;
                  void onChooseFolder!()
                    .then((cwd) => {
                      if (
                        cwd &&
                        mounted.current &&
                        !latest.current.disabled &&
                        latest.current.host === current.host &&
                        latest.current.draft === current.draft
                      )
                        latest.current.onChange({
                          cwd,
                          executionLocation: "local",
                        });
                    })
                    .catch((reason) => {
                      if (
                        mounted.current &&
                        latest.current.draft === current.draft
                      )
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : String(reason),
                        );
                    });
                }}
              >
                {t("Select folder")}
              </button>
              {draft.cwd && (
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => onChange({ cwd: undefined })}
                >
                  {t("Remove")}
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="task-error" data-no-translate>
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}
