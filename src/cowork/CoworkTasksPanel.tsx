import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Code, ListTodo } from "../ui/glyphs";
import type { Approval, Conversation } from "../../shared/types";
import { currentLocale, formatText, useLocale } from "../i18n";
import { type MenuPosition } from "../ui/Menu";
import { taskSections, tasksPanelWidth, type TaskKind } from "./task-sections";
import { TaskStatusTile, taskStatus } from "./task-status";
import { useTaskSchedules } from "./useTaskSchedules";
import { lazyPiece } from "../ui/lazy-piece";
import { taskRailSessionSource } from "./task-rail-context";
import type { TaskRailView } from "./useTaskRail";
import { coworkTasksPanelView } from "./CoworkTasksPanelView";

export const ActivityPanel = lazyPiece(
  () => import("./ActivityPanel"),
  "ActivityPanel",
);
import type { Artifact } from "../ui/ArtifactTypes";
import "./cowork-active.css";
import "./task-rail.css";

export function taskPanelTime(timestamp: number, now: number, locale: string) {
  if (!timestamp) return "";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  const relative = new Intl.RelativeTimeFormat(locale, {
    style: "narrow",
    numeric: "auto",
  });
  if (minutes < 1) return relative.format(0, "second");
  if (minutes < 60) return relative.format(-minutes, "minute");
  if (minutes < 1440) return relative.format(-Math.floor(minutes / 60), "hour");
  if (minutes < 10080)
    return relative.format(-Math.floor(minutes / 1440), "day");
  return new Date(timestamp).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

export function taskNextRun(timestamp: number, now: number, locale: string) {
  const minutes = Math.round((timestamp - now) / 60_000);
  const relative = new Intl.RelativeTimeFormat(locale, {
    style: "narrow",
    numeric: "auto",
  });
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(minutes) < 360)
    return relative.format(Math.round(minutes / 60), "hour");
  return new Date(timestamp).toLocaleString(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Tasks panel sections, filter and resize bounds.
export function CoworkTasksPanel({
  conversations,
  approvals,
  onOpen,
  onRoutine,
  onClose,
  onError,
  accountId = "",
  controllerScope,
  active,
  tasksAvailable = true,
  view: selectedView,
  onViewChange,
  onArtifact,
  onWidthChange,
  activityScope,
}: {
  conversations: Conversation[];
  approvals: Approval[];
  onOpen: (conversation: Conversation) => void;
  onRoutine: (id: string) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
  accountId?: string;
  controllerScope?: unknown;
  active?: Conversation;
  tasksAvailable?: boolean;
  activityScope?: string | number;
  view?: TaskRailView;
  onViewChange?: (view: "tasks" | "activity") => void;
  onArtifact?: (artifact: Artifact) => void;
  onWidthChange?: (width: number) => void;
}) {
  useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const source = active?.environment?.kind === "space" ? "remote" : "local";
  const sessionScope = JSON.stringify([
    active?.id,
    taskRailSessionSource(active),
  ]);
  const schedules = useTaskSchedules(
    accountId,
    tasksAvailable,
    onError,
    controllerScope,
    sessionScope,
    source === "remote",
  );
  const routines = schedules.rows ?? [];
  const [localView, setLocalView] = useState<"tasks" | "activity">("tasks");
  const activity = Boolean(
    active && (!tasksAvailable || (selectedView ?? localView) === "activity"),
  );
  const changeView = (view: "tasks" | "activity") => {
    setLocalView(view);
    onViewChange?.(view);
  };
  const contentId = useId();
  const [filter, setFilter] = useState<Set<TaskKind>>(new Set());
  const [filterPosition, setFilterPosition] = useState<MenuPosition>();
  const [viewAll, setViewAll] = useState<"attention" | "done">();
  const [width, setWidth] = useState(() => {
    try {
      return tasksPanelWidth(
        Number(localStorage.getItem("dispatch.taskPanel.width")) || 320,
      );
    } catch {
      return 320;
    }
  });
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const panelRoot = useRef<HTMLElement>(null);
  const carousel = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({
    overflow: false,
    start: true,
    end: true,
  });
  const drag = useRef<
    { position: number; scroll: number; moved: boolean } | undefined
  >(undefined);
  const updateScroll = () => {
    const track = carousel.current;
    if (track)
      setScroll({
        overflow: track.scrollWidth > track.clientWidth + 1,
        start: track.scrollLeft <= 1,
        end: track.scrollLeft + track.clientWidth >= track.scrollWidth - 1,
      });
  };
  useEffect(() => {
    const track = carousel.current;
    if (!track) return;
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(track);
    updateScroll();
    return () => observer.disconnect();
  }, [routines, filter, viewAll]);
  useEffect(() => {
    try {
      localStorage.setItem("dispatch.taskPanel.width", String(width));
    } catch {
      /* Storage can be blocked. */
    }
  }, [width]);
  useLayoutEffect(() => onWidthChange?.(width), [width, onWidthChange]);
  const ongoing = routines
    .filter((routine) => routine.enabled)
    .sort((left, right) => left.nextRunAt - right.nextRunAt);
  const sections = taskSections(conversations, approvals, ongoing, filter);
  const waiting = new Set(approvals.map((approval) => approval.conversationId));
  const titles = {
    active: "Active",
    attention: "Needs attention",
    done: "Done",
  };
  const renderRows = (rows: Conversation[]) =>
    rows.map((conversation) => (
      <a
        className="cowork-panel-row"
        data-status={taskStatus(conversation, waiting.has(conversation.id))}
        key={conversation.id}
        href={`/chat/${encodeURIComponent(conversation.id)}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          onOpen(conversation);
        }}
      >
        <TaskStatusTile
          status={taskStatus(conversation, waiting.has(conversation.id))}
          pullRequestState={
            conversation.mode === "code"
              ? conversation.pullRequests?.at(-1)?.state
              : undefined
          }
        />
        <span className="cowork-panel-row-text">
          <span>
            <strong>
              {routines.find(
                (routine) => routine.id === conversation.scheduledTaskId,
              )?.name ||
                conversation.title.trim() ||
                conversation.id}
            </strong>
            <small>
              {taskPanelTime(conversation.updatedAt, now, currentLocale())}
            </small>
          </span>
          <small>
            {conversation.mode === "code" ? (
              <Code size={12} />
            ) : (
              <ListTodo size={12} />
            )}
            {conversation.turns.at(-1)?.error ||
              (conversation.mode === "code"
                ? conversation.branch ||
                  conversation.repository?.fullName ||
                  conversation.cwd?.split(/[\\/]/).pop() ||
                  formatText("Code")
                : conversation.turns[0]?.prompt?.trim() ||
                  conversation.cwd?.split(/[\\/]/).pop() ||
                  formatText("Cowork"))}
          </small>
        </span>
      </a>
    ));
  const coworkTasksPanelViewView = coworkTasksPanelView({
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
  });
  return coworkTasksPanelViewView;
}
