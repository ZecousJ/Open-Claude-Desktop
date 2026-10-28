import { formatText, useLocale, t } from "../../i18n";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import { EllipsisVertical, ChevronDown, Pin, PinFilled } from "../../ui/glyphs";
import type { Conversation, Project } from "../../../shared/types";
import { projectKind } from "../../../shared/project-kind";
import { type Routine } from "../../../shared/routines";
import { AppContext } from "../../app/AppContext";
import { useHost } from "../../host/HostContext";
import { type MenuEntry } from "../../ui/Menu";
import { WithTooltip } from "../../ui/Tooltip";
import { ProjectBreadcrumb } from "./ProjectBreadcrumb";
import "./project-overview.css";
import { projectOverviewView } from "./ProjectOverviewView";

export const ProjectOutputs = lazyPiece(
  () => import("./ProjectOutputs"),
  "ProjectOutputs",
);
export const ProjectHubCards = lazyPiece(
  () => import("./ProjectHubCards"),
  "ProjectHubCards",
);

/**
 * The routines saved on this computer, kept current (the Scheduled section
 * lists the ones tied to the project). Empty where the host has no
 * scheduler (the web).
 */
function useRoutines(available: boolean, onError: (error: unknown) => void) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  useEffect(() => {
    if (!available) return;
    let alive = true;
    window.desktop
      .listSchedules()
      .then((list) => alive && setRoutines(list))
      .catch((error) => alive && onError(error));
    const off = window.desktop.onEvent((event) => {
      if (alive && event.type === "schedules") setRoutines(event.schedules);
    });
    return () => {
      alive = false;
      off();
    };
  }, [available]);
  return routines;
}

/**
 * This computer's name (the host's system report), for the folder block's
 * "On {deviceName}" line; undefined until known, or where the host does not
 * report it.
 */
function useDeviceName(wanted: boolean) {
  const [name, setName] = useState<string>();
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    Promise.resolve()
      .then(() => window.desktop.systemState())
      .then(
        (state) => alive && setName(state.deviceName?.trim() || undefined),
        // The line is only a hint; without the name it is left out.
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [wanted]);
  return wanted ? name : undefined;
}

/**
 * The project's description under its name: up to three lines, its own line
 * breaks kept, no Show more.
 */
export function ProjectDescription({ description }: { description: string }) {
  return (
    <p className="prj-overview-description" data-no-translate>
      {description}
    </p>
  );
}

/**
 * A project's page: "Projects / name" at the top left; the name in the page
 * serif with Pin and ⋮; the composer, which starts a chat in the project, over
 * its Recents (or the knowledge line when there are none); and at the right one
 * card with Instructions, Context, Folder and Scheduled, each with its +.
 */
export function ProjectOverview({
  project,
  chats,
  composer,
  menuOpen,
  onBack,
  onMenu,
  onSave,
  onScheduled,
  onNewTask,
  onOpenTask,
  onOpenConversation,
}: {
  project: Project;
  chats: Conversation[];
  /** The composer bound to this project (the app's own). */
  composer: ReactNode;
  menuOpen: boolean;
  onBack: () => void;
  onMenu: (anchor: HTMLElement, onMemory?: () => void) => void;
  onSave: (project: Project) => Promise<void>;
  /** Kept for callers; the Folder section asks the host itself. */
  onChooseFolder?: () => Promise<string | null>;
  onScheduled: () => void;
  /** Starts a new routine tied to the project on the Scheduled page. */
  onNewTask?: (project: Project) => void;
  /** Opens one of the project's routines on the Scheduled page. */
  onOpenTask?: (routine: Routine) => void;
  onOpenConversation: (conversation: Conversation) => void;
}) {
  useLocale();
  const app = useContext(AppContext);
  // The web runs in a sandbox: a project has no folder on the person's computer.
  const web = useHost().kind === "web";
  const kind = projectKind(project);
  const pinLabel = project.pinned ? "Unpin project" : "Pin project";
  const [searchHeader, setSearchHeader] = useState<HTMLDivElement | null>(null);
  const [instructions, setInstructions] = useState(false);
  const memoryAction = useRef<
    ((anchor?: HTMLButtonElement) => void) | undefined
  >(undefined);
  const projectWindow = app?.windowRole.kind === "project";
  const [windowPinned, setWindowPinned] = useState(false);
  useEffect(() => {
    if (!projectWindow) return;
    let active = true;
    void window.desktop
      .getWindowPinned()
      .then((value) => {
        if (active) setWindowPinned(value);
      })
      .catch((error) => app?.report(error));
    return () => {
      active = false;
    };
  }, [projectWindow]);
  const deviceName = useDeviceName(!web && Boolean(project.cwd));
  const [taskMenu, setTaskMenu] = useState<DOMRect>();
  const taskButton = useRef<HTMLButtonElement>(null);
  // Files dropped on the rail go to the project's knowledge (live).
  const rail = useRef<HTMLElement>(null);
  const report = (error: unknown) => app?.report(error);
  const scheduling =
    useHost().capabilities.scheduledTasks && Boolean(onNewTask);
  const routines = useRoutines(scheduling, report);
  const tasks = routines.filter((routine) => routine.projectId === project.id);
  // Links a routine to the project, or lets it go.
  const link = (routine: Routine, projectId: string | undefined) =>
    window.desktop.saveSchedule({ ...routine, projectId }).catch(report);
  const taskEntries = (): MenuEntry[] => {
    const loose = routines.filter((routine) => !routine.projectId);
    return [
      ...(loose.length
        ? [
            { heading: "Existing tasks" },
            ...loose.map((routine) => ({
              label: routine.name,
              noTranslate: true,
              onSelect: () => void link(routine, project.id),
            })),
            { separator: true as const },
          ]
        : []),
      { label: "Create new task", onSelect: () => onNewTask?.(project) },
    ];
  };
  const pinButton = !project.archivedAt && (
    <WithTooltip label={t(pinLabel)}>
      {(props) => (
        <button
          {...props}
          type="button"
          className="prj-overview-icon"
          aria-label={t(pinLabel)}
          aria-pressed={Boolean(project.pinned)}
          onClick={() =>
            void onSave({ ...project, pinned: !project.pinned }).catch(report)
          }
        >
          {project.pinned ? (
            <PinFilled size={web ? 20 : 17} />
          ) : (
            <Pin size={web ? 20 : 17} />
          )}
        </button>
      )}
    </WithTooltip>
  );
  const moreButton = (
    <button
      type="button"
      className={`prj-overview-icon${web ? " prj-overview-more" : ""}`}
      aria-label={
        web
          ? formatText("More options for {title}", { title: project.name })
          : `${project.name} actions`
      }
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={(event) => {
        const anchor = event.currentTarget;
        onMenu(
          anchor,
          web && memoryAction.current
            ? () => memoryAction.current?.(anchor)
            : undefined,
        );
      }}
    >
      {web ? (
        <ChevronDown size={16} />
      ) : (
        <EllipsisVertical size={17} strokeWidth={1.6} />
      )}
    </button>
  );
  const breadcrumbs = (
    <ProjectBreadcrumb
      key={project.id}
      project={project}
      onBack={onBack}
      onSave={onSave}
      onError={report}
      backHref={web ? "/projects" : undefined}
    >
      {web && moreButton}
    </ProjectBreadcrumb>
  );
  const projectOverviewViewView = projectOverviewView({
    app,
    breadcrumbs,
    chats,
    composer,
    deviceName,
    instructions,
    kind,
    link,
    memoryAction,
    moreButton,
    onOpenConversation,
    onOpenTask,
    onSave,
    onScheduled,
    pinButton,
    project,
    projectWindow,
    rail,
    report,
    scheduling,
    searchHeader,
    setInstructions,
    setSearchHeader,
    setTaskMenu,
    setWindowPinned,
    taskButton,
    taskEntries,
    taskMenu,
    tasks,
    web,
    windowPinned,
  });
  return projectOverviewViewView;
}
