import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../../shared/types";
import type { ProjectKnowledge as Knowledge } from "../../../shared/collections-api";
import type { Routine } from "../../../shared/routines";
import { formatText, t, useLocale } from "../../i18n";
import { AppIcon } from "../../ui/app-icon";
import { Modal } from "../../ui/Controls";
import { ProjectKnowledge } from "./ProjectKnowledge";
import { ProjectMemory } from "../../memory/ProjectMemory";
import { useMemory } from "../../memory/useMemory";
import { showsProjectMemory } from "../../memory/project-memory";
import "./project-hub-cards.css";

/**
 * QuietProjectRail: transparent rows, with populated counts inline. The
 * existing project operations supply their opened content.
 */
export function ProjectHubCards({
  project,
  tasks,
  onInstructions,
  onAddTask,
  onOpenTask,
  onUnlinkTask,
  onError,
  memoryAction,
  scheduling,
}: {
  project: Project;
  tasks: Routine[];
  onInstructions(): void;
  onAddTask(anchor: HTMLButtonElement): void;
  onOpenTask?: (routine: Routine) => void;
  onUnlinkTask(routine: Routine): Promise<unknown>;
  onError(error: unknown): void;
  memoryAction: RefObject<
    ((anchor?: HTMLButtonElement) => void) | null | undefined
  >;
  scheduling: boolean;
}) {
  useLocale();
  const [panel, setPanel] = useState<"context" | "scheduled" | "memory">();
  const [contextAdd, setContextAdd] = useState(false);
  const [revision, setRevision] = useState(0);
  const reads = useRef(0);
  const mounted = useRef(true);
  const activeProject = useRef(project.id);
  activeProject.current = project.id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reads.current++;
    };
  }, []);
  const [summary, setSummary] = useState<{
    projectId: string;
    value?: Knowledge;
    failed?: boolean;
  }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const memory = useMemory(onError);
  const memoryAvailable = showsProjectMemory(memory.status);
  useEffect(() => {
    const open = memoryAvailable
      ? (anchor?: HTMLButtonElement) => {
          trigger.current = anchor ?? null;
          setPanel("memory");
        }
      : undefined;
    memoryAction.current = open;
    return () => {
      if (memoryAction.current === open) memoryAction.current = undefined;
    };
  }, [memoryAvailable, memoryAction]);
  useEffect(() => {
    let alive = true;
    const request = ++reads.current;
    setSummary(undefined);
    void Promise.resolve()
      .then(() => window.desktop.listProjectKnowledge(project.id))
      .then(
        (value) => {
          if (alive && request === reads.current)
            setSummary({ projectId: project.id, value });
        },
        (error) => {
          if (alive && request === reads.current) {
            setSummary({ projectId: project.id, failed: true });
            onError(error);
          }
        },
      );
    return () => {
      alive = false;
    };
  }, [project.id, revision]);
  const current = summary?.projectId === project.id ? summary : undefined;
  const count = current?.value?.files.length;
  const close = () => {
    setPanel(undefined);
    setRevision((value) => value + 1);
    trigger.current?.focus();
  };
  const open = (next: "context" | "scheduled", button: HTMLButtonElement) => {
    setContextAdd(false);
    trigger.current = button;
    setPanel(next);
  };
  return (
    <div className="prj-hub-cards">
      <section className="prj-hub-card">
        <button
          type="button"
          className="prj-hub-card-main"
          aria-label={t(
            project.capabilities?.canEditInstructions === false
              ? "View instructions"
              : "Edit instructions",
          )}
          onClick={onInstructions}
        >
          <AppIcon name="Note" size={20} />
          <span>
            <span className="prj-hub-card-title">{t("Instructions")}</span>
            <span
              className="prj-hub-card-meta sr-only"
              data-no-translate={!!project.instructions || undefined}
            >
              {project.instructions ||
                t("Add instructions to tailor Claudex’s responses")}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="prj-hub-add"
          aria-label={t(
            project.capabilities?.canEditInstructions === false
              ? "View instructions"
              : "Edit instructions",
          )}
          onClick={onInstructions}
        >
          {t(
            project.capabilities?.canEditInstructions === false
              ? "View"
              : project.instructions.trim()
                ? "Edit"
                : "Add",
          )}
        </button>
      </section>
      <section className="prj-hub-card">
        <button
          type="button"
          className="prj-hub-card-main"
          aria-label={t("Show context")}
          onClick={(event) => open("context", event.currentTarget)}
        >
          <AppIcon name="Files" size={20} />
          <span>
            <span className="prj-hub-card-title">{t("Context")}</span>
            <span
              className={`prj-hub-card-meta${count === 0 ? " sr-only" : ""}`}
              role={count === undefined ? "status" : undefined}
            >
              {count === undefined
                ? t(
                    current?.failed
                      ? "Couldn’t load project context."
                      : "Loading…",
                  )
                : count === 1
                  ? t("1 file")
                  : formatText("{count} files", { count })}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="prj-hub-add"
          aria-label={t("Add to context")}
          onClick={(event) => {
            open("context", event.currentTarget);
            setContextAdd(true);
          }}
        >
          {t("Add")}
        </button>
      </section>
      <section className="prj-hub-card">
        <button
          type="button"
          className="prj-hub-card-main"
          aria-label={t("Scheduled tasks")}
          onClick={(event) => open("scheduled", event.currentTarget)}
        >
          <AppIcon name="Clock" size={20} />
          <span>
            <span className="prj-hub-card-title">{t("Scheduled")}</span>
            <span
              className={`prj-hub-card-meta${tasks.length ? "" : " sr-only"}`}
            >
              {tasks.length === 1
                ? t("1 scheduled task")
                : tasks.length
                  ? formatText("{count} scheduled tasks", {
                      count: tasks.length,
                    })
                  : t("Set up recurring tasks for this project.")}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="prj-hub-add"
          aria-label={t("Add scheduled task")}
          aria-haspopup={scheduling ? "menu" : undefined}
          onClick={(event) => onAddTask(event.currentTarget)}
        >
          {t("Add")}
        </button>
      </section>
      {current?.failed && (
        <button
          type="button"
          className="prj-hub-retry"
          onClick={() => setRevision((value) => value + 1)}
        >
          {t("Try again")}
        </button>
      )}
      {panel && (
        <HubDialogMount context={panel === "context"}>
          <Modal
            title={t(
              panel === "context"
                ? "Context"
                : panel === "scheduled"
                  ? "Scheduled tasks"
                  : "Memory",
            )}
            onClose={close}
            className={`prj-hub-dialog${panel === "context" ? " prj-hub-context-dialog" : ""}`}
            focusDialog={panel === "context"}
          >
            {panel === "context" ? (
              <ProjectKnowledge
                projectId={project.id}
                canEditKnowledgeBase={
                  project.capabilities?.canEditKnowledgeBase
                }
                onError={onError}
                initialAdd={contextAdd}
                contextDialog
                onCloseContext={close}
                onKnowledgeChange={(value) => {
                  if (mounted.current && activeProject.current === project.id) {
                    reads.current++;
                    setSummary({ projectId: project.id, value });
                  }
                }}
              />
            ) : panel === "memory" ? (
              <ProjectMemory projectId={project.id} onError={onError} />
            ) : (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={(event) => onAddTask(event.currentTarget)}
                >
                  {t("Add scheduled task")}
                </button>
                {tasks.length ? (
                  <ul className="prj-hub-task-list">
                    {tasks.map((routine) => (
                      <li key={routine.id}>
                        <button
                          type="button"
                          disabled={!onOpenTask}
                          data-no-translate
                          onClick={() => onOpenTask?.(routine)}
                        >
                          {routine.name}
                        </button>
                        <button
                          type="button"
                          aria-label={formatText("Unlink task {name}", {
                            name: routine.name,
                          })}
                          onClick={() =>
                            void onUnlinkTask(routine).catch(onError)
                          }
                        >
                          {t("Unlink")}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("Set up recurring tasks for this project.")}</p>
                )}
              </>
            )}
          </Modal>
        </HubDialogMount>
      )}
    </div>
  );
}

/** Keep Context out of the overview rail’s inherited compact control styles. */
function HubDialogMount({
  context,
  children,
}: {
  context: boolean;
  children: ReactNode;
}) {
  return context ? createPortal(children, document.body) : children;
}
