import { useLocale } from "../../i18n";
import { Suspense, useContext, useEffect, useRef, useState } from "react";
import type {
  Approval,
  Conversation,
  Project,
  Settings,
} from "../../../shared/types";
import {
  routineLimitMessage,
  routinesOffMessage,
  routineNameProblem,
  type Routine,
  type RoutineCapabilities,
} from "../../../shared/routines";
import { repeatOf } from "../../../shared/routine-labels";
import { usePolicy } from "../../policy/PolicyContext";
import { preference } from "../../../shared/settings-extras";
import { useHost } from "../../host/HostContext";
import { AppContext } from "../../app/AppContext";
import {
  createScheduledChat,
  scheduledChatPrompt,
} from "../../sidebar/create-scheduled-chat";
import {
  onScheduleRequest,
  requestDraft,
  takeScheduleRequest,
  type ScheduleRequest,
} from "./ScheduleConfirmCard";
import { editDraft, newDraft, type RoutineDraft } from "./routine-draft";
import {
  defaultRoutineFilter,
  type RoutineFilter,
  type RoutineSort,
} from "./routine-list";
import { useResultsKeys } from "../useResultsKeys";
import "./scheduled.css";
import "./routine-list.css";
import { useRoutineQuery, useRoutineDetail } from "./useRoutineQuery";
import { CardsSkeleton } from "../../ui/Skeleton";
import { lazyPiece } from "../../ui/lazy-piece";
import { showToast } from "../../ui/toast-store";
import { t } from "../../i18n";
import { routinesView } from "./RoutinesView";
import { routineMenus } from "./routine-menus";
import { useRoutinesPageActions } from "./useRoutinesPageActions";

// A security-review routine's findings load, with their styles, when opened.
export const SecurityFindings = lazyPiece(
  () => import("./security/SecurityFindings"),
);
export const RoutineEditor = lazyPiece(
  () => import("./RoutineEditor"),
  "RoutineEditor",
);
const RoutineDetail = lazyPiece(
  () => import("./RoutineDetail"),
  "RoutineDetail",
);

export type Tab = "yours" | "templates";
export type OpenMenu =
  | { kind: "new" | "filter" | "sort"; rect: DOMRect }
  | { kind: "row"; rect: DOMRect; routine: Routine };

export const sortLabels: Record<RoutineSort, string> = {
  next: "Next run",
  name: "Name",
  edited: "Last edited",
};
/** The original's sort menu offers these two, with no heading. */
export const sortChoices: RoutineSort[] = ["next", "name"];

/** Why the web's Scheduled page cannot make or run routines. */
export const webRoutinesMessage =
  "Scheduled tasks aren't available on this service: it runs no Cowork or Code tasks for them to start.";

export function RoutinesPage({
  settings,
  conversations = [],
  approvals = [],
  projects = [],
  onOpenProject,
  onOpenConversation,
  onChooseFolder,
  onConfirmDelete,
  onError,
  view,
  onViewChange,
  detailId: selectedDetailId,
  onDetailChange,
}: {
  settings: Settings;
  conversations?: Conversation[];
  approvals?: Approval[];
  /** The projects a task may belong to: its card names it, its menu opens it. */
  projects?: Project[];
  onOpenProject?: (id: string) => void;
  onOpenConversation: (id: string) => void;
  onChooseFolder: () => Promise<string | null>;
  /** Asks first, then deletes. */
  onConfirmDelete: (routine: Routine, remove: () => Promise<void>) => void;
  onError: (error: unknown) => void;
  /** Web address state; desktop retains its own tab. */
  view?: Tab;
  onViewChange?: (view: Tab) => void;
  detailId?: string;
  onDetailChange?: (id?: string) => void;
}) {
  useLocale();
  const policy = usePolicy();
  const [localTab, setLocalTab] = useState<Tab>("yours");
  const tab = view ?? localTab;
  const latestViewChange = useRef(onViewChange);
  latestViewChange.current = onViewChange;
  const selectTab = (next: Tab) => {
    setLocalTab(next);
    latestViewChange.current?.(next);
  };
  const [query, setQuery] = useState<string | null>(null);
  const [filter, setFilter] = useState<RoutineFilter>(defaultRoutineFilter);
  const [sort, setSort] = useState<RoutineSort>("next");
  const [menu, setMenu] = useState<OpenMenu>();
  const host = useHost();
  const app = useContext(AppContext);
  const queryOwner = app?.controllerScope ?? app?.accountId;
  const queryState = useRoutineQuery(
    host.capabilities.scheduledTasks,
    queryOwner,
    host.kind === "web",
  );
  const routines = queryState.tasks;
  const loading = queryState.loading;
  const sourceFailures = queryState.sources.filter(
    (source) => source.status !== "ready",
  );
  const loadError = sourceFailures.length > 0 && !routines.length;
  const [draft, setDraft] = useState<RoutineDraft>();
  const [localDetailId, setLocalDetailId] = useState<string>();
  const detailId = onDetailChange ? selectedDetailId : localDetailId;
  const detailRead = useRoutineDetail(
    host.capabilities.scheduledTasks ? detailId : undefined,
    queryOwner,
  );
  const latestDetailChange = useRef(onDetailChange);
  latestDetailChange.current = onDetailChange;
  const selectDetail = (id?: string) => {
    setLocalDetailId(id);
    latestDetailChange.current?.(id);
  };
  const [running, setRunning] = useState<string>();
  const [findings, setFindings] = useState<Routine>();
  const [confirming, setConfirming] = useState<RoutineDraft>();
  const latestChatSetup = useRef<() => void>(() => {});
  /** A saved routine to open in the editor once the list has it (a project's task row). */
  const [editing, setEditing] = useState<string>();
  // `/schedule <description>` in the Code composer (R13-D).
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const latestProjects = useRef(projects);
  latestProjects.current = projects;
  const latestHost = useRef(host);
  latestHost.current = host;
  useEffect(() => {
    const confirmRequest = (request?: ScheduleRequest) => {
      if (!request) return;
      try {
        if (request.openRoutineId !== undefined) {
          selectDetail(request.openRoutineId ?? undefined);
          selectTab("yours");
          setDraft(undefined);
          setConfirming(undefined);
          setEditing(undefined);
          return;
        }
        if (request.describe) {
          latestChatSetup.current();
          return;
        }
        if (request.routineId) {
          setEditing(request.routineId);
          setConfirming(undefined);
          selectTab("yours");
          return;
        }
        if (request.blank) {
          // A project's "Create new task": an empty editor tied to it.
          const project = latestProjects.current.find(
            (value) => value.id === request.projectId,
          );
          setDraft({
            ...newDraft(
              Date.now(),
              undefined,
              project?.kind === "code" ? "code" : "cowork",
            ),
            projectId: request.projectId,
            cwd: request.cwd ?? project?.cwd,
            environment: project?.environment,
            executionLocation:
              project?.environment?.kind === "space" ? "remote" : "local",
          });
          setConfirming(undefined);
          selectTab("yours");
          return;
        }
        setConfirming(
          requestDraft(request, latestSettings.current, Date.now()),
        );
        setDraft(undefined);
        selectTab("yours");
      } catch (error) {
        onError(error);
      }
    };
    confirmRequest(takeScheduleRequest());
    return onScheduleRequest(confirmRequest);
  }, []);
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  // Down Arrow in the search goes to the first routine, the arrow keys move
  // between routines and Escape comes back; Escape in the box just leaves it.
  const keys = useResultsKeys(searchInput, results);
  const newButton = useRef<HTMLButtonElement>(null);
  const filterAnchor = useRef<HTMLSpanElement>(null);
  const sortAnchor = useRef<HTMLSpanElement>(null);
  const rowAnchor = useRef<HTMLElement | null>(null);

  // Where the service runs no Cowork or Code, the web shows the page with
  // routines off; otherwise the runner's scheduler runs them.
  const web = !host.capabilities.scheduledTasks;
  // The web's page is claude.ai's Scheduled tasks: its own names and layout.
  const isWeb = host.kind === "web";
  async function refresh() {
    await queryState.refresh();
    if (detailId) await detailRead.refresh();
  }
  const retry = () => void queryState.refresh();
  useEffect(() => {
    if (query !== null) searchInput.current?.focus();
  }, [query !== null]);
  useEffect(() => {
    if (!editing || loading) return;
    setEditing(undefined);
    selectDetail(editing);
  }, [editing, loading, loadError, routines]);

  const off = !policy.scheduledTasks.enabled;
  /**
   * Why a Cowork task on this computer is on hold: Computer access is off,
   * so it neither runs on schedule nor now (electron/scheduler.ts). The
   * original's copy names the organization; here it is the person's own
   * setting (Settings → Cowork).
   */
  const holdReason = (routine: Routine) =>
    routine.mode === "cowork" &&
    routine.executionLocation !== "remote" &&
    !isWeb &&
    preference(settings, "computerAccess") === false
      ? repeatOf(routine).kind === "once"
        ? "This task is on hold because Computer access is off. It will still run if you turn Computer access back on by the scheduled time. If not, schedule a new time for it."
        : "This task is on hold because Computer access is off. It will start running again automatically when you turn Computer access back on."
      : undefined;
  const limit = policy.scheduledTasks.maxTasks;
  const atLimit = limit !== null && routines.length >= limit;
  const blocked = web
    ? webRoutinesMessage
    : off
      ? routinesOffMessage
      : atLimit
        ? routineLimitMessage(limit!)
        : undefined;
  const startChatSetup = () => {
    if (blocked || !app) return;
    // Z's Chat branch routes the empty setup request to shared-18 DP. Reuse the
    // same real Chat draft/submit path as the sidebar, including
    // translated-draft delivery and owner guards.
    createScheduledChat(app, t(scheduledChatPrompt));
  };
  latestChatSetup.current = startChatSetup;
  /** Whether the task backend also supports cloud execution. */
  const [taskCapabilities, setTaskCapabilities] =
    useState<RoutineCapabilities>();
  const {
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
  } = useRoutinesPageActions({
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
    // The new task dialog offers the chat setup where the New task menu
    // does (routine-menus.tsx).
    onSetUpWithChat:
      app && taskCapabilities?.setupWithChat === true
        ? () => latestChatSetup.current()
        : undefined,
  });
  if (detailId && !detail)
    return (
      <div
        className="routines-view"
        aria-busy={detailRead.status === "loading" || undefined}
      >
        <div className="routines-inner">
          {detailRead.status === "loading" ? (
            <CardsSkeleton />
          ) : (
            <div
              className="routines-load-error"
              data-read-state={detailRead.status}
              role={detailRead.status === "missing" ? "status" : "alert"}
            >
              <span>
                {detailRead.status === "missing"
                  ? "That scheduled task is no longer available."
                  : detailRead.status === "refused"
                    ? "You don’t have access to this scheduled task."
                    : "Couldn’t load this scheduled task."}
              </span>
              {(detailRead.status === "error" ||
                detailRead.status === "refused") &&
                detailRead.message && (
                  <span data-no-translate>{detailRead.message}</span>
                )}
              {detailRead.status !== "missing" && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void detailRead.refresh()}
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => selectDetail(undefined)}
              >
                Back
              </button>
            </div>
          )}
        </div>
      </div>
    );
  if (detail)
    return (
      <>
        <Suspense fallback={null}>
          <RoutineDetail
            key={detail.id}
            routine={detail}
            onClose={() => selectDetail(undefined)}
            onEdit={() =>
              setDraft(editDraft(detail, repeatOf(detail), settings))
            }
            onRename={async (name) => {
              const problem = routineNameProblem(name, routines, detail.id);
              if (problem) throw new Error(problem);
              await window.desktop.saveSchedule({ ...detail, name });
              await refresh();
            }}
            onDelete={() =>
              onConfirmDelete(detail, async () => {
                await window.desktop.deleteSchedule(detail.id);
                selectDetail(undefined);
                await refresh();
              })
            }
            hold={holdReason(detail)}
            onRun={() => void runNow(detail)}
            running={running === detail.id}
            disabled={off}
            onEnabled={(enabled) => void setEnabled(detail, enabled)}
            onRecover={async () => {
              await window.desktop.saveSchedule({ ...detail, enabled: true });
              await refresh();
            }}
            onRemoveApproval={(index) =>
              void window.desktop
                .removeRoutineApproval(detail.id, detail.alwaysAllowed![index])
                .then(refresh)
                .catch(() =>
                  showToast(
                    t("Tool approval couldn’t be removed. You can try again."),
                    { variant: "danger" },
                  ),
                )
            }
            onOpenConversation={onOpenConversation}
          />
        </Suspense>
        {editor}
      </>
    );
  const { menuEntries, menuWidth, renderCard } = routineMenus({
    app,
    approvals,
    blocked,
    completedCount,
    conversations,
    filter,
    holdReason,
    isWeb,
    latestChatSetup,
    menu,
    off,
    offered,
    onConfirmDelete,
    onOpenProject,
    projects,
    refresh,
    rowAnchor,
    runNow,
    running,
    runsOnChoices,
    selectDetail,
    setDraft,
    setEnabled,
    setFilter,
    setFindings,
    setMenu,
    setShowCompleted,
    setSort,
    settings,
    showCompleted,
    sort,
    startNew,
    taskCapabilities,
  });
  const pageView = routinesView({
    blocked,
    completedCount,
    confirming,
    editor,
    filterAnchor,
    filtered,
    filtering,
    findings,
    isWeb,
    keys,
    loadError,
    loading,
    menu,
    menuEntries,
    menuWidth,
    newButton,
    off,
    onError,
    onOpenConversation,
    open,
    query,
    queryState,
    refresh,
    renderCard,
    results,
    retry,
    routines,
    rowAnchor,
    rows,
    runNow,
    searchInput,
    sections,
    selectTab,
    setConfirming,
    setDraft,
    setFilter,
    setFindings,
    setMenu,
    setQuery,
    settings,
    showCompleted,
    sortAnchor,
    sourceFailures,
    startNew,
    tab,
    web,
  });
  return pageView;
}
