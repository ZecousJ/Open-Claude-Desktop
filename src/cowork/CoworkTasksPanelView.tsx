import { formatText, currentLocale } from "../i18n";
import { tasksPanelWidth, tasksPanelLimit } from "./task-sections";
import {
  ChevronLeft,
  X,
  Settings,
  Filter,
  Beaker,
  Code,
  ListTodo,
  ChevronRight,
  Clock,
} from "../ui/glyphs";
import { Menu } from "../ui/Menu";
import { Suspense } from "react";
import { Spinner } from "../ui/Spinner";
import { ActivityPanel, taskNextRun } from "./CoworkTasksPanel";
import type { Conversation, DesktopAPI } from "../../shared/types";
import type { TaskKind } from "./task-sections";
import type { MenuPosition } from "../ui/Menu";
import type { Artifact } from "../ui/ArtifactTypes";
import type { Routine, RoutineSourceState } from "../../shared/routines";

/** What coworkTasksPanelView needs from CoworkTasksPanel.tsx. */
export interface CoworkTasksPanelViewKit {
  active: Conversation | undefined;
  activity: boolean;
  activityScope: string | number | undefined;
  carousel: React.RefObject<HTMLDivElement | null>;
  changeView: (view: "tasks" | "activity") => void;
  contentId: string;
  drag: React.RefObject<
    { position: number; scroll: number; moved: boolean } | undefined
  >;
  filter: Set<TaskKind>;
  filterPosition: MenuPosition | undefined;
  filterTrigger: React.RefObject<HTMLButtonElement | null>;
  now: number;
  onArtifact: ((artifact: Artifact) => void) | undefined;
  onClose: () => void;
  onRoutine: (id: string) => void;
  ongoing: Routine[];
  panelRoot: React.RefObject<HTMLElement | null>;
  renderRows: (rows: Conversation[]) => React.JSX.Element[];
  schedules:
    | {
        retry: () => void;
        scope: {
          accountId: string;
          bridge: DesktopAPI | undefined;
          controllerScope: unknown;
          sessionScope: unknown;
          enabled: boolean;
          remote: boolean;
        };
        rows?: Routine[] | undefined;
        pending: boolean;
        error: boolean;
        sourceFailures?: RoutineSourceState[] | undefined;
      }
    | {
        retry: () => void;
        rows: undefined;
        pending: boolean;
        error: boolean;
        sourceFailures: never[];
      };
  scroll: { overflow: boolean; start: boolean; end: boolean };
  sections: Record<"active" | "attention" | "done", Conversation[]>;
  sessionScope: string;
  setFilter: React.Dispatch<React.SetStateAction<Set<TaskKind>>>;
  setFilterPosition: React.Dispatch<
    React.SetStateAction<MenuPosition | undefined>
  >;
  setViewAll: React.Dispatch<
    React.SetStateAction<"attention" | "done" | undefined>
  >;
  setWidth: React.Dispatch<React.SetStateAction<number>>;
  tasksAvailable: boolean;
  titles: { active: string; attention: string; done: string };
  updateScroll: () => void;
  viewAll: "attention" | "done" | undefined;
  width: number;
}

export function coworkTasksPanelView(kit: CoworkTasksPanelViewKit) {
  const {
    active,
    activity,
    activityScope,
    carousel,
    changeView,
    contentId,
    drag,
    filter,
    filterPosition,
    filterTrigger,
    now,
    onArtifact,
    onClose,
    onRoutine,
    ongoing,
    panelRoot,
    renderRows,
    schedules,
    scroll,
    sections,
    sessionScope,
    setFilter,
    setFilterPosition,
    setViewAll,
    setWidth,
    tasksAvailable,
    titles,
    updateScroll,
    viewAll,
    width,
  } = kit;
  const coworkTasksPanelViewView = (
    <aside
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (filterPosition) {
          setFilterPosition(undefined);
          filterTrigger.current?.focus();
        } else if (!activity && viewAll) setViewAll(undefined);
        else onClose();
      }}
      ref={panelRoot}
      className="cowork-tasks-panel"
      aria-label={formatText(activity ? "Session activity panel" : "Tasks")}
      style={{ width }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={formatText("Resize tasks panel")}
        aria-valuemin={240}
        aria-valuemax={560}
        aria-valuenow={width}
        className="cowork-tasks-resize"
        onDoubleClick={() => setWidth(320)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidth((value) =>
            tasksPanelWidth(value + (event.key === "ArrowLeft" ? 16 : -16)),
          );
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const panel = panelRoot.current;
          if (!panel) return;
          const bounds = panel.getBoundingClientRect();
          setWidth(
            tasksPanelWidth(
              getComputedStyle(panel).direction === "rtl"
                ? event.clientX - bounds.left
                : bounds.right - event.clientX,
            ),
          );
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      <header>
        {!activity && viewAll && (
          <button
            type="button"
            aria-label={formatText("Back")}
            onClick={() => setViewAll(undefined)}
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <h2>
          {formatText(
            activity ? "Settings" : viewAll ? titles[viewAll] : "Tasks",
          )}
        </h2>
        {active && tasksAvailable && (
          <button
            type="button"
            aria-label={formatText(activity ? "Close settings" : "Settings")}
            aria-pressed={activity}
            aria-controls={contentId}
            onClick={() => {
              setFilterPosition(undefined);
              changeView(activity ? "tasks" : "activity");
            }}
          >
            {activity ? <X size={16} /> : <Settings size={16} />}
          </button>
        )}
        {!activity && tasksAvailable && (
          <button
            ref={filterTrigger}
            type="button"
            aria-label={formatText("Filter tasks")}
            aria-haspopup="menu"
            aria-expanded={Boolean(filterPosition)}
            aria-pressed={filter.size > 0}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setFilterPosition(
                filterPosition
                  ? undefined
                  : {
                      right: window.innerWidth - bounds.right,
                      top: bounds.bottom + 4,
                    },
              );
            }}
          >
            <Filter size={16} />
          </button>
        )}
        <button
          type="button"
          aria-label={formatText("Close")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {filterPosition && (
        <Menu
          label={formatText("Filter tasks")}
          position={filterPosition}
          width="max-content"
          anchors={[filterTrigger]}
          onClose={() => setFilterPosition(undefined)}
          entries={(["dispatch", "code", "cowork"] as const).map((kind) => ({
            label: { dispatch: "Dispatch", code: "Code", cowork: "Cowork" }[
              kind
            ],
            icon:
              kind === "dispatch" ? (
                <Beaker size={20} />
              ) : kind === "code" ? (
                <Code size={20} />
              ) : (
                <ListTodo size={20} />
              ),
            checked: filter.has(kind),
            checkedRole: "checkbox",
            keepOpen: true,
            onSelect: () =>
              setFilter((previous) => {
                const next = new Set(previous);
                if (next.has(kind)) next.delete(kind);
                else next.add(kind);
                return next;
              }),
          }))}
        />
      )}
      <div
        id={contentId}
        className={`cowork-tasks-content${activity ? " cowork-task-activity" : ""}`}
      >
        {activity && active ? (
          <Suspense
            fallback={
              <div className="cowork-tasks-read-state" role="status">
                <Spinner size={16} />
                <span>{formatText("Loading...")}</span>
              </div>
            }
          >
            <ActivityPanel
              key={activityScope ?? sessionScope}
              conversation={active}
              embedded
              onArtifact={onArtifact ?? (() => {})}
              onClose={() => changeView("tasks")}
            />
          </Suspense>
        ) : (
          <>
            {schedules.pending && (
              <div className="cowork-tasks-read-state" role="status">
                <Spinner size={16} />
                <span>{formatText("Loading...")}</span>
              </div>
            )}
            {schedules.error && (
              <div className="cowork-tasks-read-state" role="alert">
                <span>
                  {schedules.sourceFailures?.length
                    ? schedules.sourceFailures
                        .map((source) =>
                          formatText(
                            source.source === "remote"
                              ? "Couldn’t load cloud scheduled tasks."
                              : "Couldn’t load local scheduled tasks.",
                          ),
                        )
                        .join(" ")
                    : formatText("Couldn’t load scheduled tasks")}
                </span>
                <button type="button" onClick={schedules.retry}>
                  {formatText("Retry")}
                </button>
              </div>
            )}
            {viewAll ? (
              renderRows(sections[viewAll])
            ) : (
              <>
                {ongoing.length > 0 && (
                  <section className="cowork-ongoing">
                    <div className="cowork-panel-heading">
                      <h3>{formatText("Ongoing")}</h3>
                      {scroll.overflow && (
                        <span>
                          <button
                            type="button"
                            disabled={scroll.start}
                            aria-label={formatText("Scroll left")}
                            onClick={() =>
                              carousel.current?.scrollBy({
                                left: -160,
                                behavior: "smooth",
                              })
                            }
                          >
                            <ChevronLeft size={12} />
                          </button>
                          <button
                            type="button"
                            disabled={scroll.end}
                            aria-label={formatText("Scroll right")}
                            onClick={() =>
                              carousel.current?.scrollBy({
                                left: 160,
                                behavior: "smooth",
                              })
                            }
                          >
                            <ChevronRight size={12} />
                          </button>
                        </span>
                      )}
                    </div>
                    <div
                      className="cowork-ongoing-track"
                      ref={carousel}
                      onScroll={updateScroll}
                      onPointerDown={(event) => {
                        drag.current = {
                          position: event.clientX,
                          scroll: event.currentTarget.scrollLeft,
                          moved: false,
                        };
                      }}
                      onPointerMove={(event) => {
                        if (!drag.current || !event.buttons) return;
                        const delta = event.clientX - drag.current.position;
                        if (Math.abs(delta) > 4) {
                          drag.current.moved = true;
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                        }
                        if (drag.current.moved)
                          event.currentTarget.scrollLeft =
                            drag.current.scroll - delta;
                      }}
                      onPointerUp={(event) => {
                        if (
                          event.currentTarget.hasPointerCapture(event.pointerId)
                        )
                          event.currentTarget.releasePointerCapture(
                            event.pointerId,
                          );
                      }}
                      onPointerCancel={() => {
                        drag.current = undefined;
                      }}
                      onClickCapture={(event) => {
                        if (drag.current?.moved) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                        drag.current = undefined;
                      }}
                    >
                      {ongoing.map((routine) => (
                        <a
                          key={routine.id}
                          href={`/scheduled-task/${encodeURIComponent(routine.id)}`}
                          onClick={(event) => {
                            if (
                              event.button ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            onRoutine(routine.id);
                          }}
                          title={
                            routine.repeat?.kind === "manual" ||
                            !Number.isFinite(routine.nextRunAt)
                              ? formatText("Manually run")
                              : formatText("Next run {when}", {
                                  when: taskNextRun(
                                    routine.nextRunAt,
                                    now,
                                    currentLocale(),
                                  ),
                                })
                          }
                        >
                          {routine.lastRunStatus === "running" ? (
                            <Spinner
                              inheritColor
                              size={12}
                              className="cowork-task-spin"
                            />
                          ) : (
                            <Clock size={12} />
                          )}
                          <span>
                            {routine.name ||
                              routine.description ||
                              routine.prompt ||
                              routine.id}
                          </span>
                        </a>
                      ))}
                    </div>
                  </section>
                )}
                {!schedules.pending &&
                  !schedules.error &&
                  schedules.rows !== undefined &&
                  !ongoing.length &&
                  !Object.values(sections).some((rows) => rows.length) && (
                    <p className="cowork-tasks-empty">
                      {formatText("No tasks yet")}
                    </p>
                  )}
                {(["active", "attention", "done"] as const).map(
                  (section) =>
                    sections[section].length > 0 && (
                      <section className="cowork-panel-section" key={section}>
                        <div className="cowork-panel-heading">
                          <h3>{formatText(titles[section])}</h3>
                          {section !== "active" &&
                            sections[section].length > tasksPanelLimit && (
                              <button
                                type="button"
                                onClick={() => setViewAll(section)}
                              >
                                {formatText("View all")}
                                <ChevronRight size={12} />
                              </button>
                            )}
                        </div>
                        {renderRows(
                          sections[section].slice(0, tasksPanelLimit),
                        )}
                      </section>
                    ),
                )}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
  return coworkTasksPanelViewView;
}
