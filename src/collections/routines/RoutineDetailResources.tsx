import {
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Routine } from "../../../shared/routines";
import { coworkFolderPermissionMessage } from "../../../shared/cowork-api";
import { projectFolders } from "../../../shared/project-folders";
import { AppContext } from "../../app/AppContext";
import { requestProject } from "../open-requests";
import { useHost } from "../../host/HostContext";
import { formatText, t } from "../../i18n";
import { AppIcon } from "../../ui/app-icon";
import { lazyPiece } from "../../ui/lazy-piece";
import {
  routineWorkspaceMessages,
  type RoutineWorkspaceDiagnostics,
} from "../../../shared/routine-workspace";

const environmentKey = (routine: Routine) =>
  routine.environment?.kind === "ssh"
    ? `ssh:${routine.environment.hostId}`
    : "local";
const RoutineMigration = lazyPiece(
  () => import("./RoutineMigration"),
  "RoutineMigration",
);

/** The main renderer has an atomic account snapshot. Do not infer a deleted
 * project from a failed/partial project catalogue. O16 ccd3f68fe:3298–3352. */
export function RoutineDetailResources({
  routine,
  disabled,
  onEdit,
}: {
  routine: Routine;
  disabled: boolean;
  onEdit?: () => void;
}) {
  const app = useContext(AppContext);
  const host = useHost();
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({}),
    [
      routine.id,
      disabled,
      routine.projectId,
      routine.cwd,
      routine.updatedAt,
      routine.mode,
      environmentKey(routine),
      routine.executionLocation,
      app?.accountId,
      app?.controllerScope,
      bridge,
      host.kind,
      host.capabilities.localFolders,
      host.capabilities.ssh,
    ],
  );
  // This render owns these callbacks. Reading current.current as the owner
  // only when a retained callback fires would authorize its old payload with
  // a new task/account's authority.
  const owner = { routine, app, bridge, scope, disabled };
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const capture = () => {
    return () => {
      const next = current.current;
      const controller = owner.app?.currentController?.current;
      return (
        mounted.current &&
        next.scope === owner.scope &&
        typeof window !== "undefined" &&
        window.desktop === owner.bridge &&
        next.bridge === owner.bridge &&
        next.routine.id === owner.routine.id &&
        next.routine.projectId === owner.routine.projectId &&
        next.routine.mode === owner.routine.mode &&
        next.routine.cwd === owner.routine.cwd &&
        next.routine.executionLocation === owner.routine.executionLocation &&
        environmentKey(next.routine) === environmentKey(owner.routine) &&
        next.app?.accountId === owner.app?.accountId &&
        next.app?.controllerScope === owner.app?.controllerScope &&
        (!owner.app?.currentController ||
          (controller?.accountId === owner.app.accountId &&
            controller.controllerScope === owner.app.controllerScope &&
            controller.page === owner.app.page))
      );
    };
  };
  const [unlink, setUnlink] = useState<{
    scope: object;
    busy?: boolean;
    done?: boolean;
    error?: string;
  }>();
  const [folderGrant, setFolderGrant] = useState<{
    scope: object;
    busy?: boolean;
    allowed?: boolean;
    error?: string;
  }>();
  const [device, setDevice] = useState<{
    scope: object;
    name?: string;
    error?: string;
  }>();
  const pendingUnlink = useRef<(() => boolean) | undefined>(undefined);
  const pendingGrant = useRef<(() => boolean) | undefined>(undefined);
  const pendingReconnect = useRef<(() => boolean) | undefined>(undefined);
  const [workspaceAttempt, retryWorkspace] = useState(0);
  const [workspace, setWorkspace] = useState<{
    scope: object;
    value?: RoutineWorkspaceDiagnostics;
    loading?: boolean;
    error?: string;
  }>();
  const project = app?.snapshot.projects.find(
    (value) => value.id === routine.projectId,
  );
  const projectReady = Boolean(
    app && app.snapshot.projectCatalog?.status !== "failed",
  );
  const linked = routine.projectId && !(unlink?.scope === scope && unlink.done);
  const local = routine.executionLocation !== "remote";
  const ssh = routine.environment?.kind === "ssh";
  // Code's Runs with is a Code-source section. Ordinary unified Chat's Model
  // section is read-only/migrated only, not every task.
  const showModel = routine.mode === "code";
  const folders = local
    ? [
        ...new Set([
          ...(routine.cwd ? [routine.cwd] : []),
          ...(routine.mode === "cowork" &&
          project &&
          (project.environment?.kind === "ssh"
            ? `ssh:${project.environment.hostId}`
            : "local") === environmentKey(routine)
            ? projectFolders(project)
            : []),
        ]),
      ]
    : [];
  useEffect(() => {
    if (
      !bridge ||
      !local ||
      !folders.length ||
      typeof bridge.routineWorkspace !== "function"
    )
      return;
    const valid = capture();
    let alive = true;
    setWorkspace((old) => ({
      scope,
      loading: true,
      value: old?.scope === scope ? old.value : undefined,
    }));
    void bridge
      .routineWorkspace(routine.id)
      .then((value) => {
        if (!alive || !valid()) return;
        if (
          !value ||
          value.taskId !== routine.id ||
          !Array.isArray(value.folders) ||
          !Array.isArray(value.problems)
        )
          throw new Error(t(routineWorkspaceMessages.unavailable));
        setWorkspace({ scope, value });
      })
      .catch((error: unknown) => {
        if (alive && valid())
          setWorkspace((old) => ({
            scope,
            value: old?.scope === scope ? old.value : undefined,
            error: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => {
      alive = false;
    };
  }, [scope, workspaceAttempt]);
  const diagnostics = workspace?.scope === scope ? workspace : undefined;
  const needsFolderPermission = diagnostics?.value?.folders.some(
    (value) =>
      value.path === routine.cwd && value.state === "permission-required",
  );
  const canGrant =
    local &&
    !ssh &&
    host.kind === "desktop" &&
    host.capabilities.localFolders &&
    routine.mode === "cowork" &&
    (needsFolderPermission ||
      routine.lastError === coworkFolderPermissionMessage) &&
    routine.cwd &&
    typeof bridge?.grantCoworkFolder === "function";
  useEffect(() => {
    const valid = capture();
    let alive = true;
    setDevice(undefined);
    if (!bridge || !local || !folders.length) return;
    if (ssh) {
      if (!host.capabilities.ssh || typeof bridge?.sshListHosts !== "function")
        return;
      const hostId =
        routine.environment?.kind === "ssh"
          ? routine.environment.hostId
          : undefined;
      void bridge
        .sshListHosts()
        .then(({ hosts }) => {
          if (alive && valid())
            setDevice({
              scope,
              name: hosts.find((value) => value.id === hostId)?.label,
            });
        })
        .catch((error: unknown) => {
          if (alive && valid())
            setDevice({
              scope,
              error: error instanceof Error ? error.message : String(error),
            });
        });
    } else if (
      host.kind === "desktop" &&
      host.capabilities.localFolders &&
      typeof bridge?.routineCapabilities === "function"
    ) {
      void bridge
        .routineCapabilities("local")
        .then((value) => {
          if (alive && valid()) setDevice({ scope, name: value.computerName });
        })
        .catch((error: unknown) => {
          if (alive && valid())
            setDevice({
              scope,
              error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    return () => {
      alive = false;
    };
  }, [
    scope,
    app?.accountId,
    app?.controllerScope,
    bridge,
    local,
    ssh,
    host.kind,
    host.capabilities.localFolders,
    host.capabilities.ssh,
    folders.join("\0"),
  ]);
  const unlinkProject = async () => {
    if (
      !bridge ||
      disabled ||
      !projectReady ||
      !linked ||
      pendingUnlink.current?.()
    )
      return;
    const valid = capture();
    if (!valid()) return;
    pendingUnlink.current = valid;
    setUnlink({ scope, busy: true });
    try {
      const schedules = await bridge.listSchedules();
      if (!valid()) return;
      const latest = schedules.find(
        (value) =>
          value.id === routine.id &&
          value.executionLocation === routine.executionLocation &&
          environmentKey(value) === environmentKey(routine),
      );
      if (!latest) throw new Error(t("This scheduled task no longer exists."));
      if (latest.projectId !== routine.projectId)
        throw new Error(t("Couldn’t load this."));
      await bridge.saveSchedule({ ...latest, projectId: undefined });
      if (valid()) setUnlink({ scope, done: true });
    } catch (error) {
      if (valid())
        setUnlink({
          scope,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pendingUnlink.current === valid) pendingUnlink.current = undefined;
    }
  };
  const allowFolder = async () => {
    if (!bridge || disabled || !canGrant || pendingGrant.current?.()) return;
    const valid = capture();
    if (!valid()) return;
    pendingGrant.current = valid;
    setFolderGrant({ scope, busy: true });
    try {
      // This exact API persists a routine grant. A routine-scoped grant may
      // return state=ask because its general access() query has no routineId;
      // successful completion, not that unrelated query, acknowledges it.
      const result = await bridge.grantCoworkFolder(routine.cwd!, "session", {
        routineId: routine.id,
      });
      if (result.state === "refused") throw new Error(result.reason);
      if (valid()) {
        setFolderGrant({ scope, allowed: true });
        retryWorkspace((value) => value + 1);
      }
    } catch (error) {
      if (valid())
        setFolderGrant({
          scope,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pendingGrant.current === valid) pendingGrant.current = undefined;
    }
  };
  const grant = folderGrant?.scope === scope ? folderGrant : undefined;
  const reconnect = async () => {
    if (
      disabled ||
      pendingReconnect.current?.() ||
      !diagnostics?.value?.canReconnect ||
      !bridge ||
      !host.capabilities.ssh ||
      typeof bridge.sshConnect !== "function" ||
      routine.environment?.kind !== "ssh"
    )
      return;
    const valid = capture();
    if (!valid()) return;
    pendingReconnect.current = valid;
    setWorkspace((old) =>
      old?.scope === scope ? { ...old, loading: true, error: undefined } : old,
    );
    try {
      await bridge.sshConnect(routine.environment.hostId);
      if (valid()) retryWorkspace((value) => value + 1);
    } catch (error) {
      if (valid())
        setWorkspace((old) => ({
          scope,
          value: old?.scope === scope ? old.value : undefined,
          error: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (pendingReconnect.current === valid)
        pendingReconnect.current = undefined;
    }
  };
  return (
    <>
      {app?.policy?.scheduledTasks?.enabled &&
        host.kind === "desktop" &&
        typeof bridge?.routineMigration === "function" &&
        typeof bridge?.migrateRoutine === "function" && (
          <Suspense fallback={null}>
            <RoutineMigration routine={routine} disabled={disabled} />
          </Suspense>
        )}
      {showModel && (
        <section className="routine-detail-model">
          <h2>{t("Runs with")}</h2>
          <p data-no-translate={!routine.defaultModel || undefined}>
            {routine.defaultModel ? t("Default model") : routine.model}
          </p>
        </section>
      )}
      {linked && (project || projectReady) && (
        <section className="routine-detail-project">
          <h2>{t("Project")}</h2>
          {project ? (
            <a
              href={`/project/${encodeURIComponent(project.id)}`}
              data-no-translate
              dir="auto"
              onClick={(event) => {
                if (
                  event.button ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  !app
                )
                  return;
                event.preventDefault();
                // A retained link callback cannot navigate the replacement
                // account to the previous account's project.
                if (!capture()()) return;
                requestProject(project.id);
                app.setPage("projects");
              }}
            >
              {project.name}
            </a>
          ) : (
            <>
              <p className="routine-detail-note">
                {t("This task was linked to a project that no longer exists.")}
              </p>
              {typeof bridge?.listSchedules === "function" &&
                typeof bridge?.saveSchedule === "function" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      disabled ||
                      Boolean(unlink?.scope === scope && unlink.busy)
                    }
                    aria-busy={
                      (unlink?.scope === scope && unlink.busy) || undefined
                    }
                    onClick={() => void unlinkProject()}
                  >
                    {t("Unlink")}
                  </button>
                )}
              {unlink?.scope === scope && unlink.error && (
                <p role="alert" data-no-translate>
                  {unlink.error}
                </p>
              )}
            </>
          )}
        </section>
      )}
      {folders.length > 0 && (
        <section
          className="routine-detail-folders"
          aria-busy={diagnostics?.loading || undefined}
        >
          <h2>
            {t("Folders")}
            {device?.scope === scope && device.name && (
              <span className="routine-detail-device">
                <AppIcon name="Laptop" size={12} />
                {formatText("On {name}", { name: device.name })}
              </span>
            )}
          </h2>
          {folders.map((folder) => (
            <div className="routine-detail-folder-row" key={folder}>
              <AppIcon name="Folder" size={16} />
              <bdi dir="ltr" title={folder} data-no-translate>
                {folder}
              </bdi>
              {diagnostics?.value?.folders.find(
                (value) => value.path === folder,
              )?.message && (
                <span role="status">
                  {t(
                    diagnostics.value.folders.find(
                      (value) => value.path === folder,
                    )!.message!,
                  )}
                </span>
              )}
              {(canGrant || grant?.allowed) &&
                folder === routine.cwd &&
                (grant?.allowed ? (
                  <span
                    role="img"
                    aria-label={t("Allowed for this task on this computer")}
                  >
                    <AppIcon name="Check" size={16} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled || grant?.busy}
                    aria-busy={grant?.busy || undefined}
                    aria-label={formatText("Allow {folder} on this computer", {
                      folder,
                    })}
                    title={t(
                      grant?.error
                        ? "Couldn’t allow this folder on this computer. Click to try again."
                        : "Not allowed for this task on this computer. Click to allow.",
                    )}
                    onClick={() => void allowFolder()}
                  >
                    <AppIcon name="Warning" size={16} />
                  </button>
                ))}
            </div>
          ))}
          {diagnostics?.value?.problems.map((problem) => (
            <p role="alert" key={problem}>
              {t(
                routineWorkspaceMessages[
                  problem === "too-many" ? "tooMany" : problem
                ],
              )}
            </p>
          ))}
          {diagnostics?.error && (
            <p role="alert" data-no-translate>
              {diagnostics.error}
            </p>
          )}
          {diagnostics?.value?.canReconnect &&
            host.capabilities.ssh &&
            typeof bridge?.sshConnect === "function" && (
              <button
                type="button"
                className="ghost"
                disabled={disabled || diagnostics.loading}
                onClick={() => void reconnect()}
              >
                {t("Reconnect")}
              </button>
            )}
          {(diagnostics?.error ||
            diagnostics?.value?.folders.some(
              (value) => value.state === "unavailable",
            )) && (
            <button
              type="button"
              className="ghost"
              disabled={disabled || diagnostics.loading}
              onClick={() => {
                if (capture()()) retryWorkspace((value) => value + 1);
              }}
            >
              {t("Retry")}
            </button>
          )}
          {onEdit &&
          (diagnostics?.value?.problems.length ||
            diagnostics?.value?.folders.some(
              (value) =>
                value.state === "missing" ||
                value.state === "permission-required",
            )) ? (
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() => {
                if (capture()()) onEdit();
              }}
            >
              {t("Edit task")}
            </button>
          ) : null}
          {grant?.error && (
            <p role="alert" data-no-translate>
              {grant.error}
            </p>
          )}
          {device?.scope === scope && device.error && (
            <p role="status" data-no-translate>
              {device.error}
            </p>
          )}
        </section>
      )}
    </>
  );
}
