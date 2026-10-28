import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronDown } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import type { Project, Settings } from "../../../shared/types";
import { cronProblem, cronProblemMessages } from "../../../shared/cron";
import { RoutineSchedulePreview } from "./RoutineSchedulePreview";
import { modeAllowed } from "../../../shared/client-policy";
import {
  repeatKinds,
  routineNameProblem,
  weekdayNames,
  routineModelUnavailable,
  unavailableRoutineModel,
  localRoutineName,
  type RepeatKind,
} from "../../../shared/routines";
import { onceTime } from "../../../shared/routine-labels";
import type { Schedule } from "../../../shared/types";
import { currentLocale, formatText, t } from "../../i18n";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Controls";
import { Choice } from "./ScheduledTaskDialog";
import { InfoIcon } from "../../ui/icons";
import { useHost } from "../../host/HostContext";
import { usePolicy } from "../../policy/PolicyContext";
import { ModelPicker, modelRows, sameChoice } from "./ModelPicker";
import {
  AlwaysAllowed,
  autoOffMessage,
  permissionRows,
  RoutinePermissionNotice,
} from "./RoutinePermission";
import {
  fromLocalInput,
  oncePast,
  toLocalInput,
  type RoutineDraft,
} from "./routine-draft";
import {
  RoutineContextFields,
  RoutineSourcePicker,
  useRoutineSources,
} from "./RoutineContextFields";
import { RoutineSettings } from "./RoutineSettings";
import { FieldProblem } from "./FieldProblem";
import "./scheduled.css";
import { MonthlyDayPicker } from "./MonthlyDayPicker";
import "./routine-editor.css";

const kindLabels: Record<Exclude<RepeatKind, "cron">, string> = {
  manual: "Manual",
  once: "One-time",
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom",
};

/**
 * Local task dialog. Create stays enabled while a required field is empty:
 * pressing it marks each one and focuses the first.
 */
export function RoutineEditor({
  draft,
  settings,
  onChange,
  onCancel,
  onSave,
  onChooseFolder,
  others = [],
  projects,
}: {
  draft: RoutineDraft;
  settings: Settings;
  onChange: (draft: RoutineDraft) => void;
  onCancel: () => void;
  /** Resolves when saved; rejects with the reason it was refused. */
  onSave: () => Promise<void>;
  onChooseFolder: () => Promise<string | null>;
  /** The saved routines, for the name check. */
  others?: Pick<Schedule, "id" | "name">[];
  projects?: readonly Project[];
}) {
  const sources = useRoutineSources(draft.executionLocation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initial = useRef(JSON.stringify(draft));
  const [discarding, setDiscarding] = useState(false);
  const instructions = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = instructions.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [draft.prompt]);
  const close = () => {
    if (busy) return;
    if (JSON.stringify(draft) !== initial.current) setDiscarding(true);
    else onCancel();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const host = useHost();
  const [menu, setMenu] = useState<"model" | "day">();
  const policy = usePolicy();
  const modelButton = useRef<HTMLButtonElement>(null);
  const dayButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLInputElement>(null);
  // Set once Create is pressed with a required field empty.
  const [checked, setChecked] = useState(false);
  const descriptionProblemId = useId();
  const promptProblemId = useId();
  useEffect(() => {
    if (!draft.id) nameInput.current?.focus();
  }, []);
  const set = (patch: Partial<RoutineDraft>) =>
    onChange({
      ...draft,
      ...patch,
      ...("description" in patch ? { descriptionProvided: true } : {}),
    });
  // The administrator can turn Auto off; a routine is not saved on it.
  const autoOff = !modeAllowed(policy, "auto");
  const autoBlocked = autoOff && draft.permission === "auto";
  const now = Date.now();
  const past = oncePast(draft, now);
  const unavailable =
    !draft.model.default &&
    routineModelUnavailable(draft.model, settings.providers);
  const modelLabel = draft.model.default
    ? "Default"
    : (modelRows(settings.providers).find((row) =>
        sameChoice(row.choice, draft.model),
      )?.label ?? draft.model.model);
  const savedName = draft.id
    ? draft.name.trim()
    : localRoutineName(draft.name) ||
      (draft.name.trim() ? "scheduled-task" : "");
  const nameMissing = !draft.name.trim();
  const nameProblem =
    routineNameProblem(savedName, others, draft.id) ??
    (checked && nameMissing ? t("Enter a name.") : undefined);
  const cron = draft.kind === "custom" ? cronProblem(draft.cron) : undefined;
  // The cron field shows its problem once something is typed.
  const cronShown = cron && draft.cron.trim() ? cron : undefined;
  const descriptionVisible =
    host.kind === "desktop" &&
    draft.executionLocation !== "remote" &&
    (Boolean(draft.id) || draft.mode === "code");
  const descriptionMissing = descriptionVisible && !draft.description.trim();
  const promptMissing = !draft.prompt.trim();
  // What keeps Create disabled; missing fields are marked when it is pressed.
  const ready =
    (nameMissing || !nameProblem) &&
    // A security review reviews a folder's branch: it has to be chosen.
    (!draft.securityReview || draft.cwd) &&
    settings.providers.length > 0 &&
    !cron &&
    !past &&
    !autoBlocked;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    if (nameMissing || descriptionMissing || promptMissing) {
      setChecked(true);
      (nameMissing
        ? nameInput
        : descriptionMissing
          ? descriptionInput
          : instructions
      ).current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave();
    } catch (reason) {
      setError(
        draft.id
          ? reason instanceof Error
            ? reason.message
            : String(reason)
          : "",
      );
      setBusy(false);
    }
  }
  const dayRect = dayButton.current?.getBoundingClientRect();
  return (
    <>
      <Modal
        title={
          draft.duplicateOf
            ? "Duplicate scheduled task"
            : draft.id
              ? "Edit scheduled task"
              : "New scheduled task"
        }
        className="task-dialog routine-editor-dialog"
        onClose={() => closeRef.current()}
        disablePointerDismissal={busy}
      >
        <form
          className="routine-editor"
          onSubmit={(event) => void submit(event)}
        >
          <RoutineSourcePicker
            draft={draft}
            sources={sources}
            onChange={set}
            disabled={busy}
          />
          {unavailable && (
            <p className="routine-model-warning" role="status">
              <AppIcon name="Warning" size={16} aria-hidden="true" />
              {unavailableRoutineModel.local}
            </p>
          )}
          {draft.executionLocation !== "remote" && (
            <p className="routine-banner">
              <InfoIcon size={12} />
              Local routines only run while Claudex is open and your computer is
              awake and online.
            </p>
          )}
          {draft.securityReview && (
            <p className="routine-banner">
              <InfoIcon size={12} />
              Select the folder to review. Each run reports its findings in the
              format in the instructions, which keeps them in a list you can
              triage; keep those format lines if you change the instructions.
            </p>
          )}
          <label className="routine-field">
            <span>
              Name <b aria-hidden="true">*</b>
            </span>
            <input
              ref={nameInput}
              aria-required="true"
              placeholder="daily-briefing"
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={
                nameProblem ? "routine-name-problem" : undefined
              }
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
            />
            {nameProblem &&
              (checked && nameMissing ? (
                <FieldProblem id="routine-name-problem">
                  {nameProblem}
                </FieldProblem>
              ) : (
                <span id="routine-name-problem" className="routine-field-error">
                  {nameProblem}
                </span>
              ))}
            {!nameProblem && savedName && savedName !== draft.name.trim() && (
              <span className="routine-note">
                {formatText("Will be saved as “{name}”", { name: savedName })}
              </span>
            )}
          </label>
          {descriptionVisible && (
            <label className="routine-field">
              <span>
                Description <b aria-hidden="true">*</b>
              </span>
              <input
                ref={descriptionInput}
                aria-required="true"
                aria-label="Description"
                maxLength={1000}
                placeholder="Summarize my calendar and inbox for the day"
                aria-invalid={checked && descriptionMissing ? true : undefined}
                aria-describedby={
                  checked && descriptionMissing
                    ? descriptionProblemId
                    : undefined
                }
                value={draft.description}
                onChange={(event) => set({ description: event.target.value })}
              />
              {checked && descriptionMissing && (
                <FieldProblem id={descriptionProblemId}>
                  {t("Enter a description.")}
                </FieldProblem>
              )}
            </label>
          )}
          <div className="routine-field">
            <label htmlFor="routine-instructions">
              Instructions <b aria-hidden="true">*</b>
            </label>
            <div
              className={`routine-instructions${checked && promptMissing ? " invalid" : ""}`}
            >
              <textarea
                ref={instructions}
                rows={5}
                id="routine-instructions"
                aria-required="true"
                aria-invalid={checked && promptMissing ? true : undefined}
                aria-describedby={
                  checked && promptMissing ? promptProblemId : undefined
                }
                placeholder="Look at the commits from the last 24 hours. Summarize what changed, call out any risky patterns or missing tests, and note anything worth following up on."
                value={draft.prompt}
                onChange={(event) => set({ prompt: event.target.value })}
              />
              <div className="routine-instructions-bar">
                <button
                  ref={modelButton}
                  type="button"
                  className="routine-model-button"
                  aria-haspopup="dialog"
                  aria-expanded={menu === "model"}
                  disabled={!settings.providers.length}
                  onClick={() =>
                    setMenu(menu === "model" ? undefined : "model")
                  }
                >
                  {modelLabel}
                  <ChevronDown size={12} strokeWidth={1.8} />
                </button>
              </div>
            </div>
            {checked && promptMissing && (
              <FieldProblem id={promptProblemId}>
                {t("Enter instructions.")}
              </FieldProblem>
            )}
          </div>
          <div className="routine-field routine-schedule">
            <span id="routine-schedule-label">Frequency</span>
            <Choice
              label="Frequency"
              value={draft.kind}
              options={repeatKinds.map(
                (kind) => [kind, kindLabels[kind]] as const,
              )}
              onChange={(kind) => set({ kind })}
            />
            {(draft.kind === "daily" ||
              draft.kind === "weekdays" ||
              draft.kind === "weekly" ||
              draft.kind === "monthly") && (
              <div className="routine-when">
                <span>At</span>
                <input
                  className="routine-time"
                  type="time"
                  required
                  aria-label="Time"
                  value={draft.time}
                  onChange={(event) =>
                    event.target.value && set({ time: event.target.value })
                  }
                />
                {draft.kind === "weekly" && (
                  <button
                    ref={dayButton}
                    type="button"
                    className="routine-day-button"
                    aria-haspopup="menu"
                    aria-expanded={menu === "day"}
                    onClick={() => setMenu(menu === "day" ? undefined : "day")}
                  >
                    <span>On</span>
                    {weekdayNames[draft.day]}
                    <ChevronDown size={14} strokeWidth={1.6} />
                  </button>
                )}
                {draft.kind === "monthly" && (
                  <MonthlyDayPicker
                    dayOfMonth={draft.dayOfMonth}
                    time={draft.time}
                    onChange={(dayOfMonth) => set({ dayOfMonth })}
                  />
                )}
              </div>
            )}
            {draft.kind === "once" && (
              <>
                <div className="routine-when">
                  <span>Run at</span>
                  <input
                    className="routine-time routine-at"
                    type="datetime-local"
                    required
                    aria-label="Run at"
                    aria-invalid={past && draft.at !== null ? true : undefined}
                    aria-describedby={
                      past && draft.at !== null ? "routine-at-past" : undefined
                    }
                    min={toLocalInput(now + 60_000)}
                    value={toLocalInput(draft.at)}
                    onChange={(event) =>
                      set({ at: fromLocalInput(event.target.value) })
                    }
                  />
                </div>
                {past && draft.at !== null && (
                  <span id="routine-at-past" className="routine-field-error">
                    Choose a time in the future.
                  </span>
                )}
              </>
            )}
            {draft.kind === "custom" && (
              <>
                <label className="routine-cron">
                  <span>Cron expression</span>
                  <input
                    className="routine-cron-input mono"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="0 9 * * *"
                    aria-invalid={cronShown ? true : undefined}
                    aria-describedby={
                      cronShown ? "routine-cron-problem" : undefined
                    }
                    value={draft.cron}
                    onChange={(event) => set({ cron: event.target.value })}
                  />
                  {cronShown && (
                    <span
                      id="routine-cron-problem"
                      className="routine-field-error"
                    >
                      {cronProblemMessages[cronShown]}
                    </span>
                  )}
                </label>
                {!cron && (
                  <RoutineSchedulePreview
                    expression={draft.cron}
                    executionLocation={draft.executionLocation}
                    disabled={busy}
                  />
                )}
              </>
            )}
            <p className="routine-note">
              {draft.kind === "manual"
                ? "Runs only when you start it with Run now."
                : draft.kind === "once"
                  ? draft.at !== null
                    ? formatText(
                        "Runs once on {when}. Changing the frequency will replace this schedule.",
                        { when: onceTime(draft.at, currentLocale()) },
                      )
                    : "Choose when it runs."
                  : "Scheduled tasks only run while your computer is awake and online."}
            </p>
          </div>
          <div className="routine-field routine-permissions">
            <div className="task-row">
              <span>Permissions</span>
              <Choice
                label="Permissions"
                value={draft.permission}
                minMenuWidth={256}
                options={permissionRows
                  .filter(
                    (row) => row.value !== "auto" || !autoOff || autoBlocked,
                  )
                  .map((row) => [row.value, row.label] as const)}
                onChange={(permission) => set({ permission })}
              />
            </div>
            {autoBlocked ? (
              <span className="routine-field-error" role="alert">
                {autoOffMessage}
              </span>
            ) : (
              <RoutinePermissionNotice permission={draft.permission} />
            )}
            {(draft.permission !== "bypass" ||
              draft.alwaysAllowed.length > 0) && (
              <AlwaysAllowed
                className="routine-always-allowed"
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
          </div>
          <RoutineContextFields
            draft={draft}
            projects={projects}
            onChange={set}
            onChooseFolder={onChooseFolder}
            disabled={busy}
          />
          <RoutineSettings draft={draft} onChange={set} />
          {!settings.providers.length && (
            <p className="routine-error">
              Add a model connection in Settings first.
            </p>
          )}
          {error && (
            <p className="routine-error" role="alert">
              {error}
            </p>
          )}
          <div className="routine-actions">
            <button type="button" className="routine-cancel" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="routine-create"
              disabled={!ready || busy}
            >
              {busy && <Spinner inheritColor size={12} className="spin" />}
              {draft.duplicateOf ? "Duplicate" : draft.id ? "Save" : "Create"}
            </button>
          </div>
        </form>
        {menu === "model" && (
          <ModelPicker
            providers={settings.providers}
            value={draft.model}
            anchor={modelButton}
            onChoose={(model) => set({ model })}
            onClose={() => setMenu(undefined)}
          />
        )}
        {menu === "day" && dayRect && (
          <Menu
            label="Day"
            width={Math.max(180, dayRect.width + 40)}
            position={{ left: dayRect.left, top: dayRect.bottom + 4 }}
            anchors={[dayButton]}
            entries={weekdayNames.map((name, day) => ({
              label: name,
              checked: draft.day === day,
              onSelect: () => set({ day }),
            }))}
            onClose={() => setMenu(undefined)}
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
}
