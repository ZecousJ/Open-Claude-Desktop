import { RoutineBrowserPermissions } from "./RoutineBrowserPermissions";
import { useLayoutEffect, useRef, useState } from "react";
import {
  defaultRoutinePermission,
  isCompletedOnce,
  routineDispatchAt,
} from "../../../shared/routines";
import { repeatLabel, repeatOf } from "../../../shared/routine-labels";
import { currentLocale, formatText, t, tc, useLocale } from "../../i18n";
import { AppIcon } from "../../ui/app-icon";
import { Menu } from "../../ui/Menu";
import { isEditEndKey } from "../../ui/ime";
import {
  taskPermissionText,
  windowPermissionText,
} from "../../composer/TaskPermissionPicker";
import { AlwaysAllowed } from "./RoutinePermission";
import { RoutineHistory } from "./RoutineHistory";
import { ConnectionHold } from "./ConnectionHold";
import { AutoDisabledRoutineNotice } from "./AutoDisabledRoutineNotice";
import { routineErrorText } from "./routine-error-text";
import { cardRunTime } from "./routine-list";
import type { RoutineDetailProps } from "./RoutineDetail";
import "./web-routine-detail.css";
import { RoutineDetailResources } from "./RoutineDetailResources";

/**
 * The shared unified detail. The separate Epitaxy local view is an explicit
 * presentation, not the default for every native-host task.
 */
export function WebRoutineDetail({
  routine,
  onClose,
  onEdit,
  onRename,
  onDelete,
  onRun,
  onEnabled,
  onRecover,
  onRemoveApproval,
  onOpenConversation,
  running,
  disabled,
  hold,
  runActionPlacement = "header",
}: RoutineDetailProps) {
  useLocale();
  const [menuRect, setMenuRect] = useState<DOMRect>();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(routine.name);
  const [renameError, setRenameError] = useState("");
  const [savingName, setSavingName] = useState(false);
  const renamePending = useRef(false);
  const cancelRename = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const repeat = repeatOf(routine);
  const completed = isCompletedOnce(routine);
  const progressing =
    running ||
    routine.lastRunStatus === "starting" ||
    routine.lastRunStatus === "running";
  const runBlocked =
    disabled || progressing || Boolean(hold) || !routine.prompt;
  const primaryInHeader = runActionPlacement === "header";
  const permission = routine.permission ?? defaultRoutinePermission;
  const permissionInfo = windowPermissionText[permission];
  const permissionName =
    permission === "default"
      ? "Manual"
      : permission === "auto"
        ? "Auto"
        : permissionInfo.label;
  const permissionDescription =
    permission === "auto"
      ? "Runs without asking."
      : taskPermissionText[permission].description;
  const schedule =
    repeat.kind === "manual"
      ? t("Manual only")
      : repeatLabel(repeat, currentLocale());
  const status =
    routine.connectionHold || (hold && routine.enabled)
      ? "On hold"
      : !routine.enabled && routine.endedReason
        ? "Auto-disabled"
        : completed
          ? "Ran"
          : routine.enabled
            ? tc("task-status", "Active")
            : "Paused";
  const next =
    routine.enabled &&
    !routine.connectionHold &&
    repeat.kind !== "manual" &&
    !completed
      ? formatText(
          repeat.kind === "once" ? "Runs at: {date}" : "Next run: {date}",
          { date: cardRunTime(routineDispatchAt(routine)) },
        )
      : undefined;
  const closeMenu = () => {
    setMenuRect(undefined);
    menuButton.current?.focus();
  };
  const startRename = () => {
    cancelRename.current = false;
    setName(routine.name);
    setRenameError("");
    setRenaming(true);
  };
  useLayoutEffect(() => {
    if (!renaming) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [renaming]);
  const finishRename = () => {
    setRenaming(false);
    requestAnimationFrame(() => nameButton.current?.focus());
  };
  const saveName = async () => {
    if (cancelRename.current || renamePending.current) return;
    const value = name.trim();
    if (!value || value === routine.name || !onRename) {
      finishRename();
      return;
    }
    renamePending.current = true;
    setSavingName(true);
    try {
      await onRename(value);
      finishRename();
    } catch (reason) {
      setRenameError(reason instanceof Error ? reason.message : String(reason));
      nameInput.current?.focus();
    } finally {
      renamePending.current = false;
      setSavingName(false);
    }
  };

  return (
    <div className="routines-view routine-detail routine-detail-web">
      <div className="scheduled-detail-toolbar">
        <a
          href="/scheduled-task"
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
            onClose();
          }}
        >
          Scheduled tasks
        </a>
        <span className="scheduled-detail-slash" aria-hidden="true">
          /
        </span>
        {renaming ? (
          <span className="scheduled-detail-name-field">
            <input
              ref={nameInput}
              aria-label="Name"
              data-no-translate
              dir="auto"
              value={name}
              maxLength={500}
              disabled={savingName}
              aria-invalid={Boolean(renameError) || undefined}
              onChange={(event) => {
                setName(event.target.value);
                setRenameError("");
              }}
              onBlur={() => void saveName()}
              onKeyDown={(event) => {
                if (isEditEndKey(event, "Enter")) {
                  event.preventDefault();
                  void saveName();
                }
                if (isEditEndKey(event, "Escape")) {
                  event.preventDefault();
                  cancelRename.current = true;
                  finishRename();
                }
              }}
            />
          </span>
        ) : (
          <>
            <button
              ref={nameButton}
              type="button"
              className="scheduled-detail-name"
              disabled={!onRename || disabled}
              aria-label={formatText("Rename {name}", { name: routine.name })}
              onClick={startRename}
            >
              <span dir="auto" data-no-translate>
                {routine.name}
              </span>
            </button>
            <button
              ref={menuButton}
              type="button"
              className="scheduled-detail-options"
              aria-haspopup="menu"
              aria-expanded={Boolean(menuRect)}
              aria-label={formatText("More options for {title}", {
                title: routine.name,
              })}
              onClick={() =>
                setMenuRect(
                  menuRect
                    ? undefined
                    : menuButton.current?.getBoundingClientRect(),
                )
              }
            >
              <AppIcon name="CaretDown" size={16} />
            </button>
          </>
        )}
      </div>
      {menuRect && (
        <Menu
          label={formatText("More options for {title}", {
            title: routine.name,
          })}
          className="scheduled-detail-menu"
          width={128}
          size="regular"
          anchors={[menuButton]}
          position={{
            left: Math.max(
              8,
              Math.min(menuRect.right - 128, window.innerWidth - 136),
            ),
            top: menuRect.bottom + 6,
          }}
          onClose={closeMenu}
          entries={[
            {
              label: "Rename",
              icon: <AppIcon name="Edit" size={16} />,
              disabled: !onRename || disabled,
              onSelect: startRename,
            },
            {
              label: "Edit",
              icon: <AppIcon name="Settings" size={16} />,
              disabled,
              onSelect: onEdit,
            },
            { separator: true },
            {
              label: "Delete",
              icon: <AppIcon name="Trash" size={16} />,
              danger: true,
              disabled,
              onSelect: onDelete,
            },
          ]}
        />
      )}
      <div className="scheduled-detail-scroll">
        <div className="routines-inner">
          {renameError && (
            <p className="routine-error" role="alert" data-no-translate>
              {routineErrorText(renameError)}
            </p>
          )}
          <header className="scheduled-detail-header">
            <div className="scheduled-detail-heading">
              <h1 dir="auto" data-no-translate>
                {routine.name}
              </h1>
              {next && <p>{next}</p>}
            </div>
            <div className="scheduled-detail-actions">
              <button
                type="button"
                className={`${primaryInHeader ? "primary" : "ghost"} scheduled-detail-run`}
                data-icon-only={!primaryInHeader || undefined}
                aria-label={!primaryInHeader ? t("Run now") : undefined}
                aria-busy={progressing || undefined}
                disabled={runBlocked}
                title={hold}
                onClick={onRun}
              >
                <AppIcon name="Play" size={20} />
                {primaryInHeader && (progressing ? "In progress" : "Run now")}
              </button>
              <div className="scheduled-detail-status">
                <span>{status}</span>
                {repeat.kind !== "manual" && !completed && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={routine.enabled}
                    aria-label="Enable schedule"
                    className="scheduled-detail-switch"
                    disabled={disabled}
                    onClick={() => onEnabled(!routine.enabled)}
                  />
                )}
              </div>
            </div>
          </header>
          {hold && routine.enabled && (
            <p className="routine-detail-hold" role="status">
              {hold}
            </p>
          )}
          <hr className="scheduled-detail-divider" />
          <div className="scheduled-detail-grid">
            <div className="scheduled-detail-history">
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
              <h2>History</h2>
              <RoutineHistory
                routine={routine}
                onOpenConversation={onOpenConversation}
                emptyRunAction={
                  !primaryInHeader
                    ? {
                        onRun,
                        running: progressing,
                        disabled: runBlocked,
                        reason: hold,
                      }
                    : undefined
                }
              />
            </div>
            <div className="scheduled-detail-sidebar">
              <section>
                <h2>Instructions</h2>
                <button
                  type="button"
                  className="scheduled-detail-edit"
                  aria-label="Edit instructions"
                  onClick={onEdit}
                  disabled={disabled}
                >
                  <span
                    className="scheduled-detail-prompt"
                    dir="auto"
                    data-no-translate
                  >
                    {routine.prompt}
                  </span>
                </button>
              </section>
              <section>
                <h2>Repeats</h2>
                <button
                  type="button"
                  className="scheduled-detail-edit"
                  aria-label={formatText("Repeats: {schedule}", { schedule })}
                  onClick={onEdit}
                  disabled={disabled}
                >
                  {schedule}
                </button>
              </section>
              <section>
                <h2>Permissions</h2>
                <button
                  type="button"
                  className="scheduled-detail-edit scheduled-detail-permission"
                  aria-label={formatText("Permissions: {mode}", {
                    mode: t(permissionName),
                  })}
                  onClick={onEdit}
                  disabled={disabled}
                >
                  <AppIcon name={permissionInfo.glyph} size={16} />
                  <span>
                    <span>{permissionName}</span>
                    <small>{permissionDescription}</small>
                  </span>
                </button>
              </section>
              {Boolean(routine.alwaysAllowed?.length) && (
                <AlwaysAllowed
                  className="routine-detail-allowed"
                  items={routine.alwaysAllowed!}
                  onRemove={onRemoveApproval}
                />
              )}
              <RoutineBrowserPermissions
                key={routine.id}
                routine={routine}
                readOnly={disabled}
              />
              <RoutineDetailResources
                key={routine.id}
                routine={routine}
                disabled={disabled}
                onEdit={onEdit}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
