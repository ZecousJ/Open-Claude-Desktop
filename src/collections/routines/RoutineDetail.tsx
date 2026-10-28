import { RoutineBrowserPermissions } from "./RoutineBrowserPermissions";
import { useContext, useState } from "react";
import { AppContext } from "../../app/AppContext";
import { Play, ChevronLeft, Trash2 } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { IconButton } from "../../ui/Controls";
import {
  routineDispatchAt,
  isCompletedOnce,
  type Routine,
} from "../../../shared/routines";
import {
  repeatLabel,
  repeatOf,
  routineSavedPermission,
} from "../../../shared/routine-labels";
import { currentLocale, formatText, tc, useLocale } from "../../i18n";
import { AlwaysAllowed, permissionRows } from "./RoutinePermission";
import { RoutineHistory } from "./RoutineHistory";
import "./routine-detail.css";
import { ConnectionHold } from "./ConnectionHold";
import { WebRoutineDetail } from "./WebRoutineDetail";
import { AutoDisabledRoutineNotice } from "./AutoDisabledRoutineNotice";

/** Local task details. */
export interface RoutineDetailProps {
  /** Main Scheduled pages use the shared frame on web and desktop.
   * The separate local Epitaxy view must be requested explicitly. */
  presentation?: "unified" | "legacy-local";
  /** Source frame primary vs compact header/empty-history action placement. */
  runActionPlacement?: "header" | "history";
  routine: Routine;
  onClose: () => void;
  onEdit: () => void;
  onRename?: (name: string) => Promise<void>;
  /** Asks first, then deletes the task. */
  onDelete: () => void;
  onRun: () => void;
  onEnabled: (enabled: boolean) => void;
  onRecover?: () => Promise<void>;
  onRemoveApproval: (index: number) => void;
  onOpenConversation: (id: string) => void;
  running: boolean;
  disabled: boolean;
  /** Why the task is on hold (it neither runs on schedule nor now), if it is. */
  hold?: string;
}

export function RoutineDetail(props: RoutineDetailProps) {
  return props.presentation === "legacy-local" ? (
    <DesktopRoutineDetail {...props} />
  ) : (
    <WebRoutineDetail {...props} />
  );
}

function DesktopRoutineDetail({
  routine,
  onClose,
  onEdit,
  onDelete,
  onRun,
  onEnabled,
  onRecover,
  onRemoveApproval,
  onOpenConversation,
  running,
  disabled,
  hold,
}: RoutineDetailProps) {
  useLocale();
  const app = useContext(AppContext);
  const [expanded, setExpanded] = useState(false);
  // A task saved before permission modes shows what it runs with (the
  // editor's and the run's rule, routineSavedPermission), not the default.
  const permission = permissionRows.find(
    (row) =>
      row.value ===
      (routine.permission ??
        routineSavedPermission(routine, app?.snapshot.settings)),
  );
  const repeat = repeatOf(routine);
  const collapsible =
    routine.prompt.split("\n").length > 3 || routine.prompt.length > 270;
  const completed = isCompletedOnce(routine);
  const progressing =
    running ||
    routine.lastRunStatus === "starting" ||
    routine.lastRunStatus === "running";
  return (
    <div className="routines-view routine-detail">
      <div className="routines-inner">
        <button className="routine-detail-back" onClick={onClose}>
          <ChevronLeft size={16} />
          Scheduled tasks
        </button>
        <header className="routine-detail-header">
          <h1 dir="auto" data-no-translate>
            {routine.name}
          </h1>
          {/* Edit and Delete as icons, then the primary Run now, disabled with
             its reason while on hold. */}
          <div className="routine-detail-actions">
            <IconButton label="Edit" onClick={onEdit}>
              <AppIcon name="Edit" />
            </IconButton>
            <IconButton label="Delete" onClick={onDelete}>
              <Trash2 size={16} />
            </IconButton>
            <button
              type="button"
              className="primary routine-detail-run"
              disabled={disabled || progressing || Boolean(hold)}
              title={hold}
              onClick={onRun}
            >
              <Play size={16} aria-hidden="true" />
              {progressing ? "In progress" : "Run now"}
            </button>
          </div>
        </header>
        <div className="routine-detail-grid">
          <div className="routine-detail-sidebar">
            {routine.description && (
              <section>
                <h2>Description</h2>
                <p dir="auto" data-no-translate>
                  {routine.description}
                </p>
              </section>
            )}
            <section>
              <h2>Status</h2>
              <div className="routine-detail-status">
                {repeat.kind !== "manual" && !completed && (
                  <button
                    role="switch"
                    aria-checked={routine.enabled}
                    aria-label={
                      routine.enabled
                        ? "Pause scheduled task"
                        : "Enable scheduled task"
                    }
                    disabled={disabled}
                    onClick={() => onEnabled(!routine.enabled)}
                  />
                )}
                <span>
                  {routine.connectionHold
                    ? "On hold"
                    : !routine.enabled && routine.endedReason
                      ? "Auto-disabled"
                      : completed
                        ? "Ran"
                        : hold && routine.enabled
                          ? "On hold"
                          : routine.enabled
                            ? tc("task-status", "Active")
                            : "Paused"}
                </span>
                {routine.enabled &&
                  !routine.connectionHold &&
                  repeat.kind !== "manual" && (
                    <span className="routine-detail-note">
                      {formatText(
                        repeat.kind === "once"
                          ? "Runs at: {date}"
                          : "Next run: {date}",
                        {
                          date: new Date(
                            routineDispatchAt(routine),
                          ).toLocaleString(currentLocale(), {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          }),
                        },
                      )}
                    </span>
                  )}
              </div>
              {hold && routine.enabled && (
                <p className="routine-detail-hold" role="status">
                  {hold}
                </p>
              )}
            </section>
            {routine.environment?.kind === "ssh" && (
              <section>
                <h2>Runs on</h2>
                <p>{routine.environment.hostId}</p>
              </section>
            )}
            {routine.cwd && (
              <section>
                <h2>Folder</h2>
                <span className="routine-detail-folder" title={routine.cwd}>
                  {routine.cwd}
                </span>
              </section>
            )}
            <section>
              <h2>Repeats</h2>
              <p>
                {repeat.kind === "manual"
                  ? "Manual only"
                  : repeatLabel(repeat, currentLocale())}
              </p>
            </section>
            {routine.permission === "auto" ||
            routine.permission === "bypass" ? (
              <section>
                <h2>Always allowed</h2>
                <button onClick={onEdit}>{permission?.label}</button>
              </section>
            ) : (
              <AlwaysAllowed
                className="routine-detail-allowed"
                items={routine.alwaysAllowed ?? []}
                onRemove={onRemoveApproval}
              />
            )}
            <RoutineBrowserPermissions
              key={routine.id}
              routine={routine}
              readOnly={disabled}
            />
          </div>
          <div className="routine-detail-main">
            <AutoDisabledRoutineNotice
              key={routine.id}
              routine={routine}
              disabled={disabled}
              onEdit={onEdit}
              onRecover={onRecover}
            />
            {routine.connectionHold && (
              <ConnectionHold
                key={routine.updatedAt}
                hold={routine.connectionHold}
                onRun={onRun}
                disabled={disabled || progressing}
              />
            )}
            <section>
              <h2>Instructions</h2>
              <div
                className={`routine-detail-instructions${collapsible && !expanded ? " collapsed" : ""}`}
                dir="auto"
                data-no-translate
              >
                {routine.prompt}
              </div>
              {collapsible && (
                <button
                  className="routine-detail-expand"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? "Show less" : "Show all"}
                </button>
              )}
            </section>
            <section>
              <h2>History</h2>
              <RoutineHistory
                routine={routine}
                onOpenConversation={onOpenConversation}
              />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
