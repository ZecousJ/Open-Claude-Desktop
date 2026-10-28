import { OverflowText } from "../../ui/OverflowText";
import { Archive, Pencil, Plus, Clock, Pause, X } from "../../ui/glyphs";
import { t, tc, currentLocale, formatText } from "../../i18n";
import { AppIcon } from "../../ui/app-icon";
import { WithTooltip } from "../../ui/Tooltip";
import { IconButton } from "../../ui/Controls";
import { WindowPinIcon } from "../../conversation-window/WindowPinIcon";
import {
  ProjectDescription,
  ProjectOutputs,
  ProjectHubCards,
} from "./ProjectOverview";
import { ProjectContextLayout } from "./ProjectContextLayout";
import { ProjectChatSearch } from "./ProjectChatSearch";
import { ProjectChats } from "./ProjectChats";
import { Suspense } from "react";
import { ProjectMemory } from "../../memory/ProjectMemory";
import { ProjectKnowledge } from "./ProjectKnowledge";
import { ProjectFolders } from "./ProjectFolders";
import { repeatLabel, repeatOf } from "../../../shared/routine-labels";
import { ProjectVisibility } from "./ProjectVisibility";
import { Menu } from "../../ui/Menu";
import { InstructionsDialog } from "./ProjectInstructionsDialog";
import type { Conversation, Project } from "../../../shared/types";
import type { Routine } from "../../../shared/routines";
import type { MenuEntry } from "../../ui/Menu";
import type { AppController } from "../../app/AppContext";

/** What projectOverviewView needs from ProjectOverview.tsx. */
export interface ProjectOverviewViewKit {
  app: AppController | undefined;
  breadcrumbs: React.JSX.Element;
  chats: Conversation[];
  composer: React.ReactNode;
  deviceName: string | undefined;
  instructions: boolean;
  kind: "chat" | "local" | "code";
  link: (
    routine: Routine,
    projectId: string | undefined,
  ) => Promise<void | Routine | undefined>;
  memoryAction: React.RefObject<
    ((anchor?: HTMLButtonElement | undefined) => void) | undefined
  >;
  moreButton: React.JSX.Element;
  onOpenConversation: (conversation: Conversation) => void;
  onOpenTask: ((routine: Routine) => void) | undefined;
  onSave: (project: Project) => Promise<void>;
  onScheduled: () => void;
  pinButton: false | React.JSX.Element;
  project: Project;
  projectWindow: boolean;
  rail: React.RefObject<HTMLElement | null>;
  report: (error: unknown) => void | undefined;
  scheduling: boolean;
  searchHeader: HTMLDivElement | null;
  setInstructions: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchHeader: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>;
  setTaskMenu: React.Dispatch<React.SetStateAction<DOMRect | undefined>>;
  setWindowPinned: React.Dispatch<React.SetStateAction<boolean>>;
  taskButton: React.RefObject<HTMLButtonElement | null>;
  taskEntries: () => MenuEntry[];
  taskMenu: DOMRect | undefined;
  tasks: Routine[];
  web: boolean;
  windowPinned: boolean;
}

export function projectOverviewView(kit: ProjectOverviewViewKit) {
  const {
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
  } = kit;
  const projectOverviewViewView = (
    <div className="prj-overview">
      {web ? (
        <div className="prj-overview-topbar">
          {breadcrumbs}
          <div className="prj-overview-header-spacer" />
          <div className="prj-overview-header-actions">
            <div className="prj-overview-search-slot" ref={setSearchHeader} />
            {pinButton}
          </div>
        </div>
      ) : (
        breadcrumbs
      )}
      <div className="prj-overview-scroller">
        <div className="prj-overview-body">
          <header className="prj-overview-head">
            <h1 data-no-translate>{project.name}</h1>
            {(project.archivedAt || project.isStarterProject) && (
              <div className="prj-overview-badges">
                {Boolean(project.archivedAt) && (
                  <span className="prj-overview-badge">
                    <Archive size={12} />
                    {t("Archived")}
                  </span>
                )}
                {project.isStarterProject && (
                  <WithTooltip
                    size="wrap"
                    content={
                      <div className="prj-example-explanation">
                        <p>
                          {t(
                            "This is an example project. Create a new project to work with your own documents.",
                          )}
                        </p>
                        {app && (
                          <button
                            type="button"
                            onClick={() => app.startProject()}
                          >
                            {t("Create new project")}
                          </button>
                        )}
                      </div>
                    }
                    label={t(
                      "This is an example project. Create a new project to work with your own documents.",
                    )}
                  >
                    {(props) => (
                      <span className="prj-overview-badge">
                        <span {...props} tabIndex={0}>
                          {t("Example project")}
                        </span>
                      </span>
                    )}
                  </WithTooltip>
                )}
              </div>
            )}
            {!web && (
              <div className="prj-overview-actions">
                {projectWindow && (
                  <IconButton
                    label={windowPinned ? "Stop keeping on top" : "Keep on top"}
                    active={windowPinned}
                    className="conversation-window-pin"
                    onClick={() =>
                      void window.desktop
                        .setWindowPinned(!windowPinned)
                        .then(setWindowPinned)
                        .catch(report)
                    }
                  >
                    <WindowPinIcon />
                  </IconButton>
                )}
                {pinButton}
                {moreButton}
              </div>
            )}
          </header>
          {project.description && (
            <ProjectDescription
              key={project.id}
              description={project.description}
            />
          )}
          <ProjectContextLayout
            key={`project-layout-${project.id}`}
            rail={rail}
            main={
              <>
                <div className="prj-overview-composer">{composer}</div>
                <ProjectChatSearch
                  key={project.id}
                  projectId={project.id}
                  chats={chats}
                  onOpen={onOpenConversation}
                  onError={report}
                  headerContainer={web ? searchHeader : undefined}
                >
                  {chats.length ? (
                    <ProjectChats
                      key={project.id}
                      chats={chats}
                      onOpen={onOpenConversation}
                    />
                  ) : (
                    <div className="prj-recents-empty">
                      <AppIcon name="Chat" size={32} />
                      <p>
                        {t(
                          "Claudex references the same knowledge every time you talk to it in this project.",
                        )}
                      </p>
                    </div>
                  )}
                </ProjectChatSearch>
                {app && (
                  <Suspense fallback={null}>
                    <ProjectOutputs chats={chats} />
                  </Suspense>
                )}
              </>
            }
          >
            {web ? (
              <Suspense fallback={null}>
                <ProjectHubCards
                  key={project.id}
                  project={project}
                  tasks={tasks}
                  onInstructions={() => setInstructions(true)}
                  onAddTask={(anchor) => {
                    taskButton.current = anchor;
                    if (scheduling) setTaskMenu(anchor.getBoundingClientRect());
                    else onScheduled();
                  }}
                  scheduling={scheduling}
                  onOpenTask={onOpenTask}
                  onUnlinkTask={(routine) => link(routine, undefined)}
                  onError={report}
                  memoryAction={memoryAction}
                />
              </Suspense>
            ) : (
              <>
                {kind === "chat" && (
                  <ProjectMemory projectId={project.id} onError={report} />
                )}
                <section>
                  <div className="prj-side-head">
                    <h2>Instructions</h2>
                    <button
                      type="button"
                      aria-label={
                        project.capabilities !== undefined &&
                        project.capabilities?.canEditInstructions !== true
                          ? "View instructions"
                          : "Edit instructions"
                      }
                      onClick={() => setInstructions(true)}
                    >
                      {project.instructions ? (
                        <Pencil size={16} strokeWidth={1.6} />
                      ) : (
                        <Plus size={16} strokeWidth={1.6} />
                      )}
                    </button>
                  </div>
                  {project.instructions ? (
                    <button
                      type="button"
                      className="prj-instructions-preview"
                      onClick={() => setInstructions(true)}
                    >
                      {project.instructions}
                    </button>
                  ) : (
                    <p className="prj-muted">
                      Add instructions to tailor Claudex’s responses
                    </p>
                  )}
                </section>
                {kind !== "chat" && (
                  <ProjectMemory projectId={project.id} onError={report} />
                )}
                <ProjectKnowledge
                  projectId={project.id}
                  canEditKnowledgeBase={
                    project.capabilities === undefined
                      ? undefined
                      : project.capabilities?.canEditKnowledgeBase === true
                  }
                  onError={report}
                  dropZone={rail}
                />
                {!web && kind === "local" && (
                  <ProjectFolders
                    project={project}
                    deviceName={deviceName}
                    onSave={onSave}
                  />
                )}
                <section>
                  <div className="prj-side-head">
                    <h2>Scheduled</h2>
                    <button
                      ref={taskButton}
                      type="button"
                      aria-label="Add scheduled task"
                      aria-haspopup={scheduling ? "menu" : undefined}
                      aria-expanded={scheduling ? Boolean(taskMenu) : undefined}
                      onClick={(event) =>
                        scheduling
                          ? setTaskMenu(
                              taskMenu
                                ? undefined
                                : event.currentTarget.getBoundingClientRect(),
                            )
                          : onScheduled()
                      }
                    >
                      <Plus size={16} strokeWidth={1.6} />
                    </button>
                  </div>
                  {tasks.length ? (
                    // A clock (a pause when paused), the name over its
                    // schedule, an Active or Paused tag, and an X that slides
                    // in on hover to unlink it.
                    <ul className="prj-tasks">
                      {tasks.map((routine) => (
                        <li key={routine.id}>
                          {routine.enabled ? (
                            <Clock
                              className="prj-task-icon"
                              size={14}
                              strokeWidth={1.6}
                              aria-hidden="true"
                            />
                          ) : (
                            <Pause
                              className="prj-task-icon"
                              size={14}
                              strokeWidth={1.6}
                              aria-hidden="true"
                            />
                          )}
                          <button
                            type="button"
                            className="prj-task-open"
                            onClick={() => onOpenTask?.(routine)}
                          >
                            <OverflowText
                              className="prj-task-name"
                              text={routine.name}
                            />
                            <span className="prj-task-meta">
                              {repeatLabel(repeatOf(routine), currentLocale())}
                            </span>
                          </button>
                          <span className="prj-task-end">
                            <span
                              className="prj-task-status"
                              data-active={routine.enabled || undefined}
                            >
                              {routine.enabled
                                ? tc("task-status", "Active")
                                : "Paused"}
                            </span>
                            <button
                              type="button"
                              className="prj-task-unlink"
                              aria-label={formatText("Unlink task {name}", {
                                name: routine.name,
                              })}
                              onClick={() => void link(routine, undefined)}
                            >
                              <X size={14} strokeWidth={1.6} />
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="prj-muted">
                      Set up recurring tasks for this project.
                    </p>
                  )}
                </section>
              </>
            )}
            <ProjectVisibility project={project} />
          </ProjectContextLayout>
        </div>
      </div>
      {taskMenu && (
        <Menu
          label="Add scheduled task"
          width={220}
          position={{
            top: taskMenu.bottom + 4,
            left: Math.max(8, taskMenu.right - 220),
          }}
          anchors={[taskButton]}
          entries={taskEntries()}
          onClose={() => setTaskMenu(undefined)}
        />
      )}
      {instructions && (
        <InstructionsDialog
          project={project}
          onClose={() => setInstructions(false)}
          onSaveTools={async (tools) => {
            await onSave({ ...project, tools });
          }}
          onSave={async (text) => {
            await onSave({ ...project, instructions: text });
            setInstructions(false);
          }}
        />
      )}
    </div>
  );
  return projectOverviewViewView;
}
