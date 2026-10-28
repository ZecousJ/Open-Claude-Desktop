import type { Routine, RoutineCapabilities } from "../../../shared/routines";
import { sortChoices, sortLabels } from "./RoutinesPage";
import { RoutineCard, isRunning } from "./RoutineCard";
import { routineAttention } from "./routine-list";
import {
  routineModelUnavailable,
  unavailableRoutineModel,
  routinesOffMessage,
  isCompletedOnce,
} from "../../../shared/routines";
import { repeatOf } from "../../../shared/routine-labels";
import type { OpenMenu } from "./RoutinesPage";
import type { MenuEntry } from "../../ui/Menu";
import { AppIcon } from "../../ui/app-icon";
import { tc, formatText } from "../../i18n";
import { Play, Pause, PlayCircle, Trash2 } from "../../ui/glyphs";
import { editDraft, duplicateDraft } from "./routine-draft";
import type {
  Approval,
  Conversation,
  Project,
  Settings,
} from "../../../shared/types";
import type { RoutineFilter, RoutineSort } from "./routine-list";
import type { RoutineDraft } from "./routine-draft";
import type { RoutineTemplate } from "./routine-templates";
import type { AppController } from "../../app/AppContext";

/** What routineMenus needs from RoutinesPage.tsx. */
export interface RoutineMenusKit {
  app: AppController | undefined;
  approvals: Approval[];
  blocked: string | undefined;
  completedCount: number;
  conversations: Conversation[];
  filter: RoutineFilter;
  holdReason: (
    routine: Routine,
  ) =>
    | "This task is on hold because Computer access is off. It will still run if you turn Computer access back on by the scheduled time. If not, schedule a new time for it."
    | "This task is on hold because Computer access is off. It will start running again automatically when you turn Computer access back on."
    | undefined;
  isWeb: boolean;
  latestChatSetup: React.RefObject<() => void>;
  menu: OpenMenu | undefined;
  off: boolean;
  offered: {
    sources: ("code" | "all" | "chat")[];
    hosts: (
      | "all"
      | "ssh"
      | "cloud"
      | "this-computer"
      | "another-computer"
      | "local-only"
    )[];
    statuses: ("all" | "active" | "paused" | "auto-disabled" | "on-hold")[];
  };
  onConfirmDelete: (routine: Routine, remove: () => Promise<void>) => void;
  onOpenProject: ((id: string) => void) | undefined;
  projects: Project[];
  refresh: () => Promise<void>;
  rowAnchor: React.RefObject<HTMLElement | null>;
  runNow: (routine: Routine) => Promise<void>;
  running: string | undefined;
  runsOnChoices: (
    | "all"
    | "ssh"
    | "cloud"
    | "this-computer"
    | "another-computer"
    | "local-only"
  )[];
  selectDetail: (id?: string | undefined) => void;
  setDraft: React.Dispatch<React.SetStateAction<RoutineDraft | undefined>>;
  setEnabled: (routine: Routine, enabled: boolean) => Promise<void>;
  setFilter: React.Dispatch<React.SetStateAction<RoutineFilter>>;
  setFindings: React.Dispatch<React.SetStateAction<Routine | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setShowCompleted: React.Dispatch<React.SetStateAction<boolean>>;
  setSort: React.Dispatch<React.SetStateAction<RoutineSort>>;
  settings: Settings;
  showCompleted: boolean;
  sort: RoutineSort;
  startNew: (
    template?: RoutineTemplate | undefined,
    location?: "local" | "remote" | undefined,
  ) => void;
  taskCapabilities: RoutineCapabilities | undefined;
}

export function routineMenus(kit: RoutineMenusKit) {
  const {
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
  } = kit;
  const renderCard = (routine: Routine) => (
    <RoutineCard
      key={routine.id}
      routine={routine}
      project={
        routine.projectId
          ? projects.find((value) => value.id === routine.projectId)
          : undefined
      }
      unread={routineAttention(routine, conversations, approvals).unread}
      needsAttention={
        routineAttention(routine, conversations, approvals).awaiting
      }
      hasFailedRun={routineAttention(routine, conversations, approvals).failed}
      modelWarning={
        routineModelUnavailable(routine, settings.providers)
          ? unavailableRoutineModel[isWeb ? "remote" : "local"]
          : undefined
      }
      off={off || Boolean(holdReason(routine))}
      hold={holdReason(routine)}
      starting={running === routine.id}
      menuOpen={menu?.kind === "row" && menu.routine.id === routine.id}
      onEdit={() => selectDetail(routine.id)}
      onMenu={(button) => {
        rowAnchor.current = button;
        setMenu(
          menu?.kind === "row" && menu.routine.id === routine.id
            ? undefined
            : {
                kind: "row",
                rect: button.getBoundingClientRect(),
                routine,
              },
        );
      }}
    />
  );

  const menuEntries = (current: OpenMenu): MenuEntry[] => {
    if (current.kind === "new") {
      return [
        // Source MQ only offers the Chat workflow when its start action is
        // available. An embedded list without App's Chat controller keeps
        // its manual editor, rather than offering an inert AI action.
        ...(app && taskCapabilities?.setupWithChat === true
          ? [
              {
                label: "Create with Claudex",
                icon: <AppIcon name="Chat" size={16} />,
                onSelect: () => latestChatSetup.current(),
              },
            ]
          : []),
        {
          label: "Set up manually",
          icon: <AppIcon name="Settings" size={16} />,
          onSelect: () => startNew(),
        },
      ];
    }
    if (current.kind === "sort")
      return [
        ...sortChoices.map((value) => ({
          label: sortLabels[value],
          checked: sort === value,
          checkedRole: "radio" as const,
          onSelect: () => setSort(value),
        })),
        { separator: true as const },
        // Completed one-time tasks stay hidden unless included.
        {
          label: "Include completed",
          hint: completedCount > 0 ? String(completedCount) : undefined,
          checked: showCompleted,
          checkedRole: "checkbox" as const,
          keepOpen: true,
          onSelect: () => setShowCompleted((value) => !value),
        },
      ];
    if (current.kind === "filter")
      return [
        ...(offered.sources.length > 2
          ? [
              { heading: tc("scheduled-filter", "Source") },
              ...offered.sources.map((value) => ({
                label: { all: "All", chat: "Chat", code: "Code" }[value],
                checked: (filter.source ?? "all") === value,
                checkedRole: "radio" as const,
                onSelect: () => setFilter({ ...filter, source: value }),
              })),
              { separator: true as const },
            ]
          : []),
        // Runs on, once tasks run somewhere other than this computer.
        ...(runsOnChoices.length > 2
          ? [
              { heading: "Runs on" },
              ...runsOnChoices.map((value) => ({
                label: {
                  all: "All",
                  cloud: "Cloud",
                  "this-computer": "This computer",
                  "another-computer": "Another computer",
                  "local-only": "Only on this computer",
                  ssh: "SSH",
                }[value],
                checked: filter.runsOn === value,
                checkedRole: "radio" as const,
                onSelect: () => setFilter({ ...filter, runsOn: value }),
              })),
              { separator: true as const },
            ]
          : []),
        // Recurring tasks start by themselves, one-time ones once.
        { heading: "Schedule" },
        ...(["all", "recurring", "once"] as const).map((value) => ({
          label: { all: "All", recurring: "Recurring", once: "One-time" }[
            value
          ],
          checked: filter.schedule === value,
          checkedRole: "radio" as const,
          onSelect: () => setFilter({ ...filter, schedule: value }),
        })),
        { separator: true as const },
        { heading: "Status" },
        ...offered.statuses.map((value) => ({
          label: {
            all: "All",
            active: tc("task-status", "Active"),
            paused: "Paused",
            "auto-disabled": "Auto-disabled",
            "on-hold": "On hold",
          }[value],
          checked: filter.status === value,
          checkedRole: "radio" as const,
          onSelect: () => setFilter({ ...filter, status: value }),
        })),
      ];
    if (current.kind !== "row") return [];
    const routine = current.routine;
    const project = routine.projectId
      ? projects.find((value) => value.id === routine.projectId)
      : undefined;
    const busy = running !== undefined || isRunning(routine);
    // The original's card menu; the run history and last run are on the task's
    // page.
    return [
      {
        label: "Run now",
        icon: <Play size={16} />,
        disabled: off || busy,
        tooltip: busy
          ? "This task is already running."
          : off
            ? routinesOffMessage
            : undefined,
        onSelect: () => void runNow(routine),
      },
      // A one-time routine that has run is switched on again by giving it a
      // new moment in Edit.
      ...(isCompletedOnce(routine)
        ? []
        : [
            routine.enabled
              ? {
                  label: "Pause",
                  icon: <Pause size={16} />,
                  onSelect: () => void setEnabled(routine, false),
                }
              : {
                  label: "Enable",
                  icon: <PlayCircle size={16} />,
                  onSelect: () => void setEnabled(routine, true),
                },
          ]),
      {
        label: "Edit",
        icon: <AppIcon name="Edit" />,
        onSelect: () =>
          setDraft(editDraft(routine, repeatOf(routine), settings)),
      },
      {
        label: "Duplicate",
        icon: <AppIcon name="Copy" />,
        disabled: Boolean(blocked),
        onSelect: () =>
          setDraft(
            duplicateDraft(
              editDraft(routine, repeatOf(routine), settings),
              formatText("Copy of {name}", { name: routine.name }),
            ),
          ),
      },
      ...(project && onOpenProject
        ? [
            {
              label: "Open project",
              icon: <AppIcon name="Projects" />,
              onSelect: () => onOpenProject(project.id),
            },
          ]
        : []),
      ...(routine.securityReview
        ? [{ label: "Findings", onSelect: () => setFindings(routine) }]
        : []),
      { separator: true },
      {
        label: "Delete",
        icon: <Trash2 size={16} />,
        danger: true,
        onSelect: () =>
          onConfirmDelete(routine, async () => {
            await window.desktop.deleteSchedule(routine.id);
            await refresh();
          }),
      },
    ];
  };
  const menuWidth =
    menu?.kind === "new" ? 180 : menu?.kind === "row" ? 168 : 176;
  return { menuEntries, menuWidth, renderCard } as const;
}
