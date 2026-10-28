import { Modal } from "../../ui/Controls";
import {
  RoutineSourcePicker,
  RoutineContextFields,
} from "./RoutineContextFields";
import { t, formatText, currentLocale } from "../../i18n";
import { Choice, frequencies } from "./ScheduledTaskDialog";
import {
  permissionRows,
  autoOffMessage,
  RoutinePermissionNotice,
  AlwaysAllowed,
} from "./RoutinePermission";
import { AppIcon } from "../../ui/app-icon";
import { windowPermissionText } from "../../composer/TaskPermissionPicker";
import { ChevronDown } from "../../ui/glyphs";
import { toLocalInput, fromLocalInput } from "./routine-draft";
import {
  weekdayNames,
  unavailableRoutineModel,
} from "../../../shared/routines";
import { MonthlyDayPicker } from "./MonthlyDayPicker";
import { FieldProblem } from "./FieldProblem";
import { RoutineTriggerList } from "./RoutineTriggerList";
import { cronProblemMessages } from "../../../shared/cron";
import { RoutineSchedulePreview } from "./RoutineSchedulePreview";
import { onceTime } from "../../../shared/routine-labels";
import { RoutineSettings } from "./RoutineSettings";
import { ModelPicker } from "./ModelPicker";
import type { RoutineDraft } from "./routine-draft";
import type { Project, Settings } from "../../../shared/types";
import type { RoutineSurface } from "./RoutineContextFields";
import type { CronProblem } from "../../../shared/cron";

/** What scheduledTaskDialogView needs from ScheduledTaskDialog.tsx. */
export interface ScheduledTaskDialogViewKit {
  autoBlocked: boolean;
  autoOff: boolean;
  busy: boolean;
  cron: CronProblem | undefined;
  cronProblemId: string;
  descriptionVisible: boolean;
  discarding: boolean;
  displayedError: string;
  draft: RoutineDraft;
  error: string;
  kind:
    | "manual"
    | "hourly"
    | "daily"
    | "weekdays"
    | "weekly"
    | "monthly"
    | "custom"
    | "once";
  modelButton: React.RefObject<HTMLButtonElement | null>;
  modelLabel: string;
  nameInput: React.RefObject<HTMLInputElement | null>;
  descriptionInput: React.RefObject<HTMLInputElement | null>;
  promptInput: React.RefObject<HTMLTextAreaElement | null>;
  nameProblem: string | undefined;
  nameProblemId: string;
  promptProblem: string | undefined;
  promptProblemId: string;
  /** The web: other triggers, Code tasks run in the cloud. */
  web: boolean;
  /** What the task was before a trigger made it a Code task. */
  baseMode: RoutineDraft["mode"];
  descriptionProblem: string | undefined;
  descriptionProblemId: string;
  now: number;
  onCancel: () => void;
  onChooseFolder: (() => Promise<string | null>) | undefined;
  onSetUpWithChat: (() => void) | undefined;
  past: boolean;
  permissionTrigger: string;
  picking: boolean;
  pristine: boolean;
  projects: readonly Project[] | undefined;
  ready: boolean;
  requestClose: React.RefObject<() => void>;
  set: (patch: Partial<RoutineDraft>) => void;
  setDiscarding: React.Dispatch<React.SetStateAction<boolean>>;
  setPicking: React.Dispatch<React.SetStateAction<boolean>>;
  settings: Settings;
  sources: readonly RoutineSurface[];
  submit: (event: React.FormEvent<Element>) => Promise<void>;
  unavailable: boolean;
}

export function scheduledTaskDialogView(kit: ScheduledTaskDialogViewKit) {
  // A Code task on the web runs as a cloud session.
  const cloudCode = kit.web && kit.draft.mode === "code";
  const {
    autoBlocked,
    autoOff,
    busy,
    cron,
    cronProblemId,
    descriptionVisible,
    discarding,
    displayedError,
    draft,
    error,
    kind,
    modelButton,
    modelLabel,
    nameInput,
    descriptionInput,
    promptInput,
    nameProblem,
    nameProblemId,
    promptProblem,
    promptProblemId,
    web,
    baseMode,
    descriptionProblem,
    descriptionProblemId,
    now,
    onCancel,
    onChooseFolder,
    onSetUpWithChat,
    past,
    permissionTrigger,
    picking,
    pristine,
    projects,
    ready,
    requestClose,
    set,
    setDiscarding,
    setPicking,
    settings,
    sources,
    submit,
    unavailable,
  } = kit;
  const scheduledTaskDialogViewView = (
    <>
      <Modal
        title={
          draft.duplicateOf
            ? "Duplicate scheduled task"
            : draft.id
              ? "Edit scheduled task"
              : "New scheduled task"
        }
        className="task-dialog scheduled-task-dialog"
        onClose={() => requestClose.current()}
        disablePointerDismissal={busy}
        subtitle={
          onSetUpWithChat && !draft.id && !draft.duplicateOf && !cloudCode ? (
            <button
              type="button"
              className="modal-subtitle-link"
              disabled={busy}
              onClick={() => {
                onCancel();
                onSetUpWithChat();
              }}
            >
              {t("Set up with Claudex instead")}
            </button>
          ) : undefined
        }
      >
        <form className="task-form" onSubmit={(event) => void submit(event)}>
          <fieldset className="task-form-body" disabled={busy}>
            <RoutineSourcePicker
              draft={draft}
              sources={sources}
              onChange={set}
              disabled={busy}
            />
            <label className="task-field">
              <span>Name</span>
              <input
                ref={nameInput}
                aria-required="true"
                disabled={busy}
                aria-label={t("Name")}
                data-no-translate
                maxLength={120}
                placeholder={t("Daily briefing")}
                value={draft.name}
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? nameProblemId : undefined}
                onChange={(event) => set({ name: event.target.value })}
              />
              {nameProblem && (
                <FieldProblem id={nameProblemId}>{nameProblem}</FieldProblem>
              )}
            </label>
            {descriptionVisible && (
              <label className="task-field">
                <span>
                  Description <b aria-hidden="true">*</b>
                </span>
                <input
                  ref={descriptionInput}
                  aria-required="true"
                  aria-label={t("Description")}
                  maxLength={1000}
                  value={draft.description}
                  aria-invalid={descriptionProblem ? true : undefined}
                  aria-describedby={
                    descriptionProblem ? descriptionProblemId : undefined
                  }
                  onChange={(event) => set({ description: event.target.value })}
                />
                {descriptionProblem && (
                  <FieldProblem id={descriptionProblemId}>
                    {descriptionProblem}
                  </FieldProblem>
                )}
              </label>
            )}
            <div className="task-field">
              <div
                className={`task-instructions${promptProblem ? " invalid" : ""}`}
              >
                <textarea
                  ref={promptInput}
                  id="task-instructions"
                  aria-required="true"
                  disabled={busy}
                  aria-label={t("Instructions")}
                  aria-invalid={promptProblem ? true : undefined}
                  aria-describedby={promptProblem ? promptProblemId : undefined}
                  data-no-translate
                  placeholder={t(
                    "Check tomorrow’s weather and tell me if I need an umbrella.",
                  )}
                  value={draft.prompt}
                  onChange={(event) => set({ prompt: event.target.value })}
                />
                <div className="task-instructions-bar">
                  {cloudCode ? (
                    // A cloud Code task's permissions are its environment's.
                    <span className="task-permission-environment">
                      <AppIcon name="LockShield" size={12} />
                      {t("Permissions set by environment")}
                    </span>
                  ) : (
                    <Choice
                      disabled={busy}
                      label="Permissions"
                      triggerLabel={formatText("Permissions: {mode}", {
                        mode: t(permissionTrigger),
                      })}
                      triggerText={permissionTrigger}
                      className="task-permission"
                      caretSize={12}
                      value={draft.permission}
                      minMenuWidth={256}
                      options={permissionRows
                        .filter(
                          (row) =>
                            row.value !== "auto" || !autoOff || autoBlocked,
                        )
                        .map((row) => [row.value, row.label] as const)}
                      icon={(permission) => (
                        <AppIcon
                          name={windowPermissionText[permission].glyph}
                          size={16}
                        />
                      )}
                      onChange={(permission) => set({ permission })}
                    />
                  )}
                  <button
                    ref={modelButton}
                    type="button"
                    className="task-model"
                    aria-label={formatText("Model: {model}", {
                      model: draft.model.default ? t(modelLabel) : modelLabel,
                    })}
                    aria-haspopup="dialog"
                    aria-expanded={picking}
                    disabled={busy || !settings.providers.length}
                    onClick={() => setPicking(!picking)}
                  >
                    <span data-no-translate={!draft.model.default || undefined}>
                      {modelLabel}
                    </span>
                    <ChevronDown size={12} strokeWidth={1.6} />
                  </button>
                </div>
              </div>
              {promptProblem && (
                <FieldProblem id={promptProblemId}>
                  {promptProblem}
                </FieldProblem>
              )}
            </div>
            {cloudCode ? null : autoBlocked ||
              draft.permission === "default" ? (
              <p className="task-note">
                {autoBlocked ? autoOffMessage : permissionRows[0].description}
              </p>
            ) : (
              <RoutinePermissionNotice permission={draft.permission} />
            )}
            <RoutineTriggerList
              draft={draft}
              busy={busy}
              canAdd={web}
              baseMode={baseMode}
              onChange={set}
              scheduleType={
                <Choice
                  disabled={busy}
                  label="Trigger type: Schedule"
                  value="schedule"
                  options={[["schedule", "Schedule"]]}
                  className="task-trigger-type"
                  caretSize={12}
                  icon={() => <AppIcon name="Clock" size={16} />}
                  onChange={() => {}}
                />
              }
              schedule={
                <>
                  <span className="task-frequency">
                    <select
                      aria-label={formatText("Frequency: {frequency}", {
                        frequency: t(
                          frequencies.find(([value]) => value === kind)?.[1] ??
                            kind,
                        ),
                      })}
                      value={kind}
                      onChange={(event) =>
                        set({ kind: event.target.value as typeof kind })
                      }
                    >
                      {frequencies.map(([value, label]) => (
                        <option key={value} value={value}>
                          {t(label)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} aria-hidden="true" />
                  </span>
                  {kind === "once" && (
                    <input
                      className="task-time task-at"
                      type="datetime-local"
                      required
                      aria-label="Run at"
                      aria-invalid={
                        past && draft.at !== null ? true : undefined
                      }
                      aria-describedby={
                        past && draft.at !== null ? "task-at-past" : undefined
                      }
                      min={toLocalInput(now + 60_000)}
                      value={toLocalInput(draft.at)}
                      onChange={(event) =>
                        set({ at: fromLocalInput(event.target.value) })
                      }
                    />
                  )}
                  {kind === "hourly" && (
                    <label className="task-minute">
                      <span>at minute</span>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        aria-label="Minute past the hour"
                        value={draft.minute}
                        onChange={(event) =>
                          set({
                            minute: Math.min(
                              59,
                              Math.max(0, Math.round(+event.target.value || 0)),
                            ),
                          })
                        }
                      />
                    </label>
                  )}
                  {(kind === "daily" ||
                    kind === "weekdays" ||
                    kind === "weekly" ||
                    kind === "monthly") && (
                    <>
                      {kind === "weekly" && (
                        <Choice
                          disabled={busy}
                          label="Day"
                          value={String(draft.day)}
                          options={weekdayNames.map(
                            (name, day) => [String(day), name] as const,
                          )}
                          onChange={(day) => set({ day: Number(day) })}
                        />
                      )}
                      <input
                        className="task-time"
                        type="time"
                        required
                        aria-label="Time"
                        value={draft.time}
                        onChange={(event) =>
                          event.target.value &&
                          set({ time: event.target.value })
                        }
                      />
                      {kind === "monthly" && (
                        <MonthlyDayPicker
                          dayOfMonth={draft.dayOfMonth}
                          time={draft.time}
                          onChange={(dayOfMonth) => set({ dayOfMonth })}
                        />
                      )}
                    </>
                  )}
                </>
              }
            />
            {unavailable && (
              <p className="routine-model-warning" role="status">
                <AppIcon name="Warning" size={16} aria-hidden="true" />
                {unavailableRoutineModel.remote}
              </p>
            )}
            {kind === "custom" && (
              <div className="task-field task-custom-cron">
                <span>Cron expression</span>
                <input
                  aria-label={t("Cron expression")}
                  data-no-translate
                  required
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="0 9 * * *"
                  value={draft.cron}
                  aria-invalid={cron && draft.cron.trim() ? true : undefined}
                  aria-describedby={
                    cron && draft.cron.trim() ? cronProblemId : undefined
                  }
                  onChange={(event) => set({ cron: event.target.value })}
                />
                {cron && draft.cron.trim() && (
                  <span id={cronProblemId} className="task-error" role="alert">
                    {t(cronProblemMessages[cron])}
                  </span>
                )}
                {!cron && (
                  <RoutineSchedulePreview
                    expression={draft.cron}
                    executionLocation={draft.executionLocation}
                    disabled={busy}
                  />
                )}
              </div>
            )}
            {kind === "once" && past && draft.at !== null && (
              <p id="task-at-past" className="task-error">
                Choose a time in the future.
              </p>
            )}
            {kind === "once" && draft.at !== null && !past && (
              <p className="task-footnote">
                {formatText(
                  "Runs once on {when}. Changing the frequency will replace this schedule.",
                  { when: onceTime(draft.at, currentLocale()) },
                )}
              </p>
            )}
            {(draft.permission === "default" ||
              draft.alwaysAllowed.length > 0) && (
              <AlwaysAllowed
                className="task-always-allowed"
                items={draft.alwaysAllowed}
                onRemove={(index) =>
                  set({
                    revokedApprovals: [
                      ...(draft.revokedApprovals ?? []),
                      draft.alwaysAllowed[index],
                    ],
                    alwaysAllowed: draft.alwaysAllowed.filter(
                      (_, at) => at !== index,
                    ),
                  })
                }
              />
            )}
            <RoutineContextFields
              draft={draft}
              projects={projects}
              onChange={set}
              onChooseFolder={onChooseFolder}
              disabled={busy}
            />
            <RoutineSettings
              draft={draft}
              onChange={set}
              disabled={busy}
              projects={projects}
              baseMode={baseMode}
            />
            {!settings.providers.length && (
              <p className="task-error">
                Add a model connection in Settings first.
              </p>
            )}
            {error && (
              <p className="task-error" role="alert" data-no-translate>
                {displayedError}
              </p>
            )}
          </fieldset>
          <div className="task-actions">
            <button
              type="button"
              className="task-cancel"
              disabled={busy}
              onClick={() => requestClose.current()}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="task-save"
              disabled={!ready || busy || pristine}
            >
              {busy
                ? "Saving…"
                : draft.duplicateOf
                  ? "Duplicate"
                  : draft.id
                    ? "Save changes"
                    : "Create"}
            </button>
          </div>
        </form>
        {picking && !busy && (
          <ModelPicker
            providers={settings.providers}
            value={draft.model}
            anchor={modelButton}
            onChoose={(model) => set({ model })}
            onClose={() => setPicking(false)}
          />
        )}
      </Modal>
      {discarding && (
        <Modal
          title="Discard unsaved changes?"
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => setDiscarding(false)}
        >
          <p className="confirm-body">
            Your changes haven’t been saved and will be lost.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => setDiscarding(false)}
            >
              Keep editing
            </button>
            <button type="button" className="primary" onClick={onCancel}>
              Discard
            </button>
          </div>
        </Modal>
      )}
    </>
  );
  return scheduledTaskDialogViewView;
}
