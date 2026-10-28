import { currentLocale } from "../../i18n";
import { Pause, Clock, Check } from "../../ui/glyphs";
import type { Project } from "../../../shared/types";
import { AppIcon } from "../../ui/app-icon";
import {
  isCompletedOnce,
  routineDispatchAt,
  type Routine,
} from "../../../shared/routines";
import { repeatLabel, repeatOf } from "../../../shared/routine-labels";
import { useHost } from "../../host/HostContext";
import { RoutineTile } from "./RoutineArt";
import { RoutineComputerBadge } from "./RoutineComputerBadge";
import { type RoutineTemplate } from "./routine-templates";
import { cardRunTime } from "./routine-list";
import "./scheduled.css";
import "./routine-list.css";
import { formatText, t, tc } from "../../i18n";

export const isRunning = (routine: Routine) =>
  routine.lastRunStatus === "starting" || routine.lastRunStatus === "running";

export function TemplateGrid({
  disabled,
  onUse,
  templates,
}: {
  disabled: boolean;
  onUse: (template: RoutineTemplate) => void;
  templates: RoutineTemplate[];
}) {
  return (
    <ul className="routine-grid routine-template-grid" aria-label="Templates">
      {templates.map((template) => (
        <li key={template.id}>
          <button
            type="button"
            className="routine-card u-press-card"
            disabled={disabled}
            onClick={() => onUse(template)}
          >
            <RoutineTile icon={template.icon} />
            <span className="routine-card-text">
              <strong>{template.name}</strong>
              <span className="routine-card-description">
                {template.description}
              </span>
              <span className="routine-card-schedule">
                <Clock size={12} strokeWidth={1.6} />
                <span>{repeatLabel(template.repeat)}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One of the person's routines: the template card plus its state and ⋯ menu. */
export function RoutineCard({
  routine,
  project,
  hold,
  unread = false,
  needsAttention = false,
  modelWarning,
  hasFailedRun = false,
  off,
  starting,
  menuOpen,
  onEdit,
  onMenu,
}: {
  routine: Routine;
  /** The project the task belongs to, named in its footer. */
  project?: Project;
  /** Why the task won't run (Computer access is off), behind a warning icon. */
  hold?: string;
  unread?: boolean;
  needsAttention?: boolean;
  modelWarning?: string;
  hasFailedRun?: boolean;
  off: boolean;
  starting: boolean;
  menuOpen: boolean;
  onEdit: () => void;
  onMenu: (button: HTMLButtonElement) => void;
}) {
  const webCard = useHost().kind === "web";
  const rule = repeatOf(routine);
  const active = isRunning(routine) || starting;
  const failed =
    hasFailedRun ||
    routine.lastRunStatus === "failed" ||
    routine.lastRunStatus === "interrupted";
  const completed = isCompletedOnce(routine);
  const state = routine.connectionHold
    ? "On hold"
    : !routine.enabled && routine.endedReason
      ? "Auto-disabled"
      : completed
        ? "Ran"
        : off && rule.kind !== "manual"
          ? "On hold"
          : !routine.enabled
            ? "Paused"
            : undefined;
  const dot = failed
    ? "failed"
    : needsAttention
      ? "needs_attention"
      : active
        ? "running"
        : unread
          ? "new_run"
          : undefined;
  const next =
    routine.enabled &&
    !routine.connectionHold &&
    !off &&
    rule.kind !== "manual" &&
    !(rule.kind === "once" && routine.lastRunAt)
      ? routineDispatchAt(routine)
      : undefined;
  const when =
    next !== undefined
      ? cardRunTime(next, Date.now(), Boolean(routine.dispatchJitterSeconds))
      : routine.enabled && routine.lastRunAt
        ? cardRunTime(routine.lastRunAt, Date.now(), false, "past")
        : undefined;
  const timing =
    next !== undefined
      ? rule.kind === "once"
        ? "Runs at: {when}"
        : "Next run: {when}"
      : "Last run: {when}";
  const [beforeTime, afterTime] = t(timing).split("{when}");
  if (webCard)
    return (
      <li
        className={`routine-item routine-web-item ${menuOpen ? "menu-open" : ""}`}
      >
        <div
          className="routine-card routine-card-web"
          aria-busy={starting || undefined}
        >
          <div className="routine-card-text">
            <div className="routine-card-name">
              <a
                href={`/scheduled-task/${encodeURIComponent(routine.id)}`}
                data-primary=""
                dir="auto"
                data-no-translate
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
                  onEdit();
                }}
              >
                {routine.name}
              </a>
              {hold && routine.enabled && (
                <span
                  className="routine-model-warning-icon"
                  role="img"
                  aria-label={`${t("Why this task won’t run")}: ${t(hold)}`}
                  title={t(hold)}
                >
                  <AppIcon name="Warning" size={16} />
                </span>
              )}
              {modelWarning && (
                <span
                  className="routine-model-warning-icon"
                  role="img"
                  aria-label={modelWarning}
                  title={modelWarning}
                >
                  <AppIcon name="Warning" size={16} />
                </span>
              )}
              {dot && (
                <span
                  className="routine-status-dot"
                  data-dot={dot}
                  role="img"
                  aria-label={
                    dot === "running"
                      ? "Running"
                      : dot === "new_run"
                        ? "New run"
                        : "Needs attention"
                  }
                />
              )}
            </div>
            {(routine.description || routine.prompt) && (
              <div
                className="routine-card-description"
                dir="auto"
                data-no-translate
              >
                {routine.description || routine.prompt.slice(0, 280)}
              </div>
            )}
            <div className="routine-card-footer">
              <span className="routine-card-status">
                {!state && (
                  <span
                    className="routine-card-active-dot"
                    aria-hidden="true"
                  />
                )}
                <span>{state ?? tc("task-status", "Active")}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>{repeatLabel(rule, currentLocale())}</span>
              <RoutineComputerBadge routine={routine} />
              {project && (
                <span className="routine-card-project">
                  <AppIcon name="Projects" size={12} />
                  <span dir="auto" data-no-translate>
                    {project.name}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="routine-more"
          aria-label={formatText("More options for {title}", {
            title: routine.name,
          })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <AppIcon name="DotsVertical" size={20} />
        </button>
      </li>
    );
  return (
    <li
      className={`routine-item routine-native-item ${routine.enabled ? "" : "is-paused"} ${menuOpen ? "menu-open" : ""}`}
    >
      <button
        type="button"
        className="routine-card u-press-card"
        data-primary=""
        onClick={onEdit}
      >
        <RoutineTile icon={routine.securityReview ? "security" : undefined} />
        <span className="routine-card-text">
          <span className="routine-card-name">
            <strong dir="auto" data-no-translate>
              {routine.name}
            </strong>
            {hold && routine.enabled && (
              <span
                className="routine-model-warning-icon"
                role="img"
                aria-label={`${t("Why this task won’t run")}: ${t(hold)}`}
                title={t(hold)}
              >
                <AppIcon name="Warning" size={16} />
              </span>
            )}
            {modelWarning && (
              <span
                className="routine-model-warning-icon"
                role="img"
                aria-label={modelWarning}
                title={modelWarning}
              >
                <AppIcon name="Warning" size={16} />
              </span>
            )}
            {dot === "needs_attention" && (
              <span className="routine-attention" aria-hidden="true">
                Needs attention
              </span>
            )}
          </span>
          {/* The description, else the instructions' first 280 characters. */}
          {(routine.description || routine.prompt) && (
            <span
              className="routine-card-description"
              dir="auto"
              data-no-translate
            >
              {routine.description || routine.prompt.slice(0, 280)}
            </span>
          )}
          <span className="routine-card-schedule">
            <span>{repeatLabel(rule, currentLocale())}</span>
            <RoutineComputerBadge routine={routine} showCloud />
          </span>
          <span className="routine-card-footer">
            <span>
              {when ? (
                <>
                  {beforeTime}
                  <span className="routine-run-time">{when}</span>
                  {afterTime}
                </>
              ) : (
                "\u00a0"
              )}
              {project && (
                <span className="routine-card-project">
                  <AppIcon name="Projects" />
                  <span dir="auto" data-no-translate>
                    {project.name}
                  </span>
                </span>
              )}
            </span>
            {state && (
              <span
                className={`routine-state ${state === "Auto-disabled" ? "failed" : state === "On hold" || state === "Paused" ? "routine-state-pill" : ""}`}
              >
                {state === "Paused" && <Pause size={16} />}
                {state === "On hold" && <Clock size={16} />}
                {state === "Ran" && <Check size={16} />}
                {state === "Auto-disabled" && (
                  <AppIcon name="Warning" size={16} />
                )}
                {state}
              </span>
            )}
          </span>
        </span>
        {dot && (
          <span
            className="routine-status-dot"
            data-dot={dot}
            role="img"
            aria-label={
              dot === "running"
                ? "Running"
                : dot === "new_run"
                  ? "New run"
                  : "Needs attention"
            }
          />
        )}
      </button>
      <button
        type="button"
        className="routine-more"
        aria-label={formatText("More options for {title}", {
          title: routine.name,
        })}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onMenu(event.currentTarget)}
      >
        <AppIcon name="DotsVertical" size={20} />
      </button>
    </li>
  );
}
