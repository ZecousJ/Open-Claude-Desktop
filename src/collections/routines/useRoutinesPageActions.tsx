import { useEffect, useState, useMemo, Suspense } from "react";
import {
  offeredRoutineFilters,
  visibleRoutines,
  listSections,
} from "./routine-list";
import type { RoutineTemplate } from "./routine-templates";
import { newDraft, draftInput } from "./routine-draft";
import { localRoutineName, routineNameProblem } from "../../../shared/routines";
import { showToast } from "../../ui/toast-store";
import { t, formatText } from "../../i18n";
import type { Routine, RoutineCapabilities } from "../../../shared/routines";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";
import { RoutineApiTokenDialog } from "./RoutineApiTokenDialog";
import { RoutineEditor } from "./RoutinesPage";
import type { RoutineDraft } from "./routine-draft";
import type { RoutineFilter, RoutineSort } from "./routine-list";
import type { OpenMenu, Tab } from "./RoutinesPage";
import type { Project, Settings } from "../../../shared/types";
import type { AppController } from "../../app/AppContext";
import type { HostInfo } from "../../../shared/host";

/** What useRoutinesPageActions needs from RoutinesPage.tsx. */
export interface UseRoutinesPageActionsKit {
  app: AppController | undefined;
  blocked: string | undefined;
  detailRead:
    | { refresh: () => Promise<void>; status: "ready"; task: Routine }
    | { refresh: () => Promise<void>; status: "missing" }
    | {
        refresh: () => Promise<void>;
        status: "error" | "refused";
        message?: string | undefined;
      }
    | { refresh: () => Promise<void>; status: "loading" };
  draft: RoutineDraft | undefined;
  filter: RoutineFilter;
  holdReason: (
    routine: Routine,
  ) =>
    | "This task is on hold because Computer access is off. It will still run if you turn Computer access back on by the scheduled time. If not, schedule a new time for it."
    | "This task is on hold because Computer access is off. It will start running again automatically when you turn Computer access back on."
    | undefined;
  host: HostInfo;
  isWeb: boolean;
  menu: OpenMenu | undefined;
  onChooseFolder: () => Promise<string | null>;
  onError: (error: unknown) => void;
  projects: Project[];
  query: string | null;
  queryOwner: string | object | undefined;
  refresh: () => Promise<void>;
  routines: Routine[];
  selectTab: (next: Tab) => void;
  setDraft: React.Dispatch<React.SetStateAction<RoutineDraft | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setRunning: React.Dispatch<React.SetStateAction<string | undefined>>;
  setTaskCapabilities: React.Dispatch<
    React.SetStateAction<RoutineCapabilities | undefined>
  >;
  settings: Settings;
  sort: RoutineSort;
  taskCapabilities: RoutineCapabilities | undefined;
  /** "Set up with Claudex instead" in the new task dialog, where offered. */
  onSetUpWithChat?: () => void;
}

export function useRoutinesPageActions(kit: UseRoutinesPageActionsKit) {
  const {
    app,
    blocked,
    detailRead,
    draft,
    filter,
    holdReason,
    host,
    isWeb,
    menu,
    onChooseFolder,
    onError,
    projects,
    query,
    queryOwner,
    refresh,
    routines,
    selectTab,
    setDraft,
    setMenu,
    setRunning,
    setTaskCapabilities,
    settings,
    sort,
    taskCapabilities,
    onSetUpWithChat,
  } = kit;
  useEffect(() => {
    let live = true;
    const bridge = window.desktop;
    setTaskCapabilities(undefined);
    void Promise.resolve()
      .then(() => bridge.routineCapabilities?.())
      .then(
        (value) =>
          live && window.desktop === bridge && setTaskCapabilities(value),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isWeb, queryOwner]);
  const filtering =
    (filter.source !== undefined && filter.source !== "all") ||
    filter.runsOn !== "all" ||
    filter.schedule !== "all" ||
    filter.status !== "all";
  /** The sort menu's Include completed (off: completed one-time tasks hide). */
  const [showCompleted, setShowCompleted] = useState(false);
  /** Offer only sources and run hosts confirmed by tasks or capabilities. */
  const offered = useMemo(
    () =>
      offeredRoutineFilters(routines, {
        cloud: taskCapabilities?.remote,
        thisComputer: !isWeb && host.capabilities.scheduledTasks,
        sources: taskCapabilities?.sources,
        statuses: taskCapabilities?.statuses,
        onHold: (routine) => Boolean(holdReason(routine)),
      }),
    [routines, taskCapabilities, host.capabilities, isWeb, settings],
  );
  const runsOnChoices = offered.hosts;
  const filtered = filtering || Boolean(query?.trim());
  const rows = useMemo(
    () =>
      visibleRoutines(routines, query ?? "", filter, sort, (routine) =>
        Boolean(holdReason(routine)),
      ),
    [routines, query, filter, sort, settings],
  );
  // One-time routines that have run wait in their own section after the rest.
  const sections = useMemo(() => listSections(rows), [rows]);
  const completedCount = sections.completed.length;

  const open = (kind: "new" | "filter" | "sort", element: HTMLElement | null) =>
    element &&
    setMenu(
      menu?.kind === kind
        ? undefined
        : { kind, rect: element.getBoundingClientRect() },
    );
  const startNew = (
    template?: RoutineTemplate,
    location?: "local" | "remote",
  ) => {
    if (blocked) return;
    const made = newDraft(
      Date.now(),
      template,
      app?.mode === "code" &&
        (host.capabilities.localCode || host.capabilities.cloudCode)
        ? "code"
        : "cowork",
    );
    const draft = location ? { ...made, executionLocation: location } : made;
    setDraft(draft);
  };
  /** Save explicit editor values; hidden optional description is not prose. */
  async function saveDraft() {
    if (!draft) return;
    const filled = draft;
    const creating = !filled.id;
    try {
      const savedName =
        isWeb || filled.id
          ? filled.name.trim()
          : localRoutineName(filled.name) || "scheduled-task";
      const existing = routines.find((routine) => routine.id === filled.id);
      const nameProblem =
        existing?.name === savedName
          ? undefined
          : routineNameProblem(savedName, routines, filled.id);
      if (nameProblem) throw new Error(nameProblem);
      if (filled.id) {
        try {
          for (const entry of filled.revokedApprovals ?? [])
            await window.desktop.removeRoutineApproval(filled.id, entry);
        } catch (error) {
          showToast(
            t("Tool approval couldn’t be removed. You can try again."),
            { variant: "danger" },
          );
          throw error;
        }
      }
      const input = draftInput(
        isWeb || filled.id
          ? filled
          : {
              ...filled,
              name: localRoutineName(filled.name) || "scheduled-task",
            },
        settings,
        Date.now(),
      );
      const saved = await window.desktop.saveSchedule({
        ...input,
        revokedApprovals: undefined,
      });
      // A new API trigger gets its token now, shown once.
      const api = saved?.triggers?.api;
      if (api && !api.tokenHint)
        try {
          const grant = await window.desktop.routineApiToken(
            api.id,
            "generate",
          );
          if (grant.token) setApiToken(grant.token);
        } catch {
          showToast(t("Failed to update API token. You can try again."), {
            variant: "danger",
          });
        }
    } catch (error) {
      if (creating)
        showToast(t("Failed to create scheduled task. You can try again."));
      throw error;
    }
    await refresh();
    setDraft(undefined);
    selectTab("yours");
    if (filled.duplicateOf) showToast(t("Scheduled task duplicated."));
    else if (creating) showToast(t("Scheduled task created"));
  }
  const [apiToken, setApiToken] = useState<string>();
  async function runNow(routine: Routine) {
    setRunning(routine.id);
    // The original's feedback.
    try {
      await window.desktop.runSchedule(routine.id);
      showToast(formatText("“{name}” started.", { name: routine.name }));
      await refresh();
    } catch (error) {
      showToast(
        formatText("Couldn’t start “{name}”. {cause}", {
          name: routine.name,
          cause: error instanceof Error ? error.message : String(error),
        }),
        { variant: "warning" },
      );
    } finally {
      setRunning(undefined);
    }
  }
  async function setEnabled(routine: Routine, enabled: boolean) {
    try {
      await window.desktop.saveSchedule({ ...routine, enabled });
      await refresh();
    } catch (error) {
      onError(error);
    }
  }

  const editor = draft ? (
    <Suspense fallback={null}>
      {isWeb ? (
        <ScheduledTaskDialog
          draft={draft}
          others={routines}
          projects={projects}
          onChooseFolder={onChooseFolder}
          settings={settings}
          onChange={setDraft}
          onCancel={() => setDraft(undefined)}
          onSave={saveDraft}
          onSetUpWithChat={onSetUpWithChat}
        />
      ) : (
        <RoutineEditor
          projects={projects}
          draft={draft}
          settings={settings}
          onChange={setDraft}
          onCancel={() => setDraft(undefined)}
          onChooseFolder={onChooseFolder}
          onSave={saveDraft}
          others={routines}
        />
      )}
    </Suspense>
  ) : apiToken ? (
    <RoutineApiTokenDialog
      token={apiToken}
      onClose={() => setApiToken(undefined)}
    />
  ) : undefined;

  const detail = detailRead.status === "ready" ? detailRead.task : undefined;
  return {
    detail,
    runNow,
    setEnabled,
    editor,
    completedCount,
    offered,
    runsOnChoices,
    setShowCompleted,
    showCompleted,
    startNew,
    filtered,
    filtering,
    open,
    rows,
    sections,
  } as const;
}
