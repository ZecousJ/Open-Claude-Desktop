import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ChevronDown } from "../../ui/glyphs";
import type { Project, Settings } from "../../../shared/types";
import { modeAllowed } from "../../../shared/client-policy";
import {
  routineModelUnavailable,
  routineNameProblem,
  routineNameReserved,
  type Routine,
} from "../../../shared/routines";
import { cronProblem } from "../../../shared/cron";
import { formatText, t } from "../../i18n";
import { windowPermissionText } from "../../composer/TaskPermissionPicker";
import { usePolicy } from "../../policy/PolicyContext";
import { Menu } from "../../ui/Menu";
import { modelRows, sameChoice } from "./ModelPicker";
import { rememberedModelLabel } from "../../composer/model/code-model-choices";
import { useRoutineSources } from "./RoutineContextFields";
import { useHost } from "../../host/HostContext";
import { routineErrorText } from "./routine-error-text";
import { oncePast, type RoutineDraft } from "./routine-draft";
import "./scheduled.css";
import "./scheduled-task-dialog.css";
import { scheduledTaskDialogView } from "./ScheduledTaskDialogView";

export const frequencies = [
  ["custom", "Custom"],
  ["once", "One-time"],
  ["manual", "Manual"],
  ["hourly", "Hourly"],
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
] as const;

/** A menu-backed field: the current choice with its chevron, the list below. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  minMenuWidth = 140,
  icon,
  triggerText,
  triggerLabel,
  caretSize = 16,
  className = "",
  disabled = false,
}: {
  label: string;
  value: T;
  /** [value, label] or [value, label, badge]. */
  options: readonly (readonly [T, string] | readonly [T, string, string])[];
  onChange: (value: T) => void;
  /** The menu is at least this wide, else the trigger's width. */
  minMenuWidth?: number;
  /** A mark before an option's label, in the field and in the menu. */
  icon?: (value: T) => ReactNode;
  /** A compact label for the current value; menu entries retain their labels. */
  triggerText?: string;
  triggerLabel?: string;
  caretSize?: number;
  className?: string;
  disabled?: boolean;
}) {
  const shown = options.find(([key]) => key === value);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const button = useRef<HTMLButtonElement>(null);
  const rect = open ? button.current?.getBoundingClientRect() : undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`task-select ${className}`}
        aria-label={triggerLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {icon?.(value)}
        <span>{triggerText ?? shown?.[1] ?? value}</span>
        {shown?.[2] && <span className="rate-badge">{shown[2]}</span>}
        <ChevronDown size={caretSize} strokeWidth={1.6} />
      </button>
      {open && !disabled && rect && (
        <Menu
          label={label}
          width={Math.max(rect.width, minMenuWidth)}
          position={{ left: rect.left, top: rect.bottom + 4 }}
          anchors={[button]}
          entries={options.map(([key, text, badge]) => ({
            label: text,
            ...(badge ? { badge } : {}),
            ...(icon ? { icon: icon(key) } : {}),
            checked: key === value,
            onSelect: () => onChange(key),
          }))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The web's "Create scheduled task": name, instructions with the model under
 * them, and the frequency with its time. Tasks here run as Cowork tasks in the
 * runner's sandbox. A new task's Permissions row starts on Auto, or on Manually
 * approve where the administrator turned Auto off; Auto lets the reviewer
 * decide. Create stays enabled while the name or instructions are empty:
 * pressing it marks what is missing and focuses the first such field. One-time
 * runs once at the chosen moment. Optional context follows the selected source
 * and executing host; ordinary captured edits retain their UI.
 */
export function ScheduledTaskDialog({
  draft,
  settings,
  onChange,
  onCancel,
  onSave,
  others = [],
  projects,
  onChooseFolder,
  onSetUpWithChat,
}: {
  draft: RoutineDraft;
  settings: Settings;
  onChange: (draft: RoutineDraft) => void;
  onCancel: () => void;
  /** "Set up with Claudex instead": a new task made in a chat instead. */
  onSetUpWithChat?: () => void;
  /** Resolves when saved; rejects with the reason it was refused. */
  onSave: () => Promise<void>;
  others?: Pick<Routine, "id" | "name">[];
  projects?: readonly Project[];
  onChooseFolder?: () => Promise<string | null>;
}) {
  const host = useHost();
  const web = host.kind === "web";
  // What the task is when no trigger makes it a Code task: a task opened
  // with one was made on the web as a Chat task unless it names a repository.
  const [baseMode] = useState<RoutineDraft["mode"]>(() =>
    web && (draft.triggers.api || draft.triggers.github) && !draft.repository
      ? "cowork"
      : draft.mode,
  );
  const sources = useRoutineSources(draft.executionLocation);
  const descriptionVisible =
    host.kind === "desktop" &&
    draft.executionLocation !== "remote" &&
    (Boolean(draft.id) || draft.mode === "code");
  const policy = usePolicy();
  // The administrator can turn Auto off; a routine is not saved on it.
  const autoOff = !modeAllowed(policy, "auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  // A new task opened on Auto where Auto is off starts on Manually approve,
  // unchanged as far as closing it goes.
  const [seed] = useState(() =>
    !draft.id && autoOff && draft.permission === "auto"
      ? { ...draft, permission: "default" as const }
      : draft,
  );
  useEffect(() => {
    if (seed !== draft) onChange(seed);
    // Only the opening draft is seeded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [initialDraft] = useState(() => JSON.stringify(seed));
  const [initialName] = useState(() => draft.name.trim());
  const [discarding, setDiscarding] = useState(false);
  // Set once Create is pressed with a required field empty.
  const [checked, setChecked] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const nameProblemId = useId();
  const promptProblemId = useId();
  const descriptionProblemId = useId();
  const cronProblemId = useId();
  const mounted = useRef(true);
  const pendingSave = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = JSON.stringify(draft) !== initialDraft;
  const requestClose = useRef(() => {});
  requestClose.current = () => {
    if (pendingSave.current || discarding) return;
    if (dirty) setDiscarding(true);
    else onCancel();
  };
  const modelButton = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<RoutineDraft>) => {
    if (!pendingSave.current)
      onChange({
        ...draft,
        ...patch,
        ...("description" in patch ? { descriptionProvided: true } : {}),
      });
  };
  const active =
    settings.providers.find((p) => p.id === settings.activeProviderId) ??
    settings.providers[0];
  // The default's name as the composer shows it (the catalog's, kept).
  const defaultName = active ? rememberedModelLabel(active.model) : undefined;
  // A cloud Code task names the default it runs on.
  const modelLabel = draft.model.default
    ? web && draft.mode === "code" && defaultName
      ? formatText("Default · {model}", { model: defaultName })
      : "Default model"
    : (modelRows(settings.providers).find((row) =>
        sameChoice(row.choice, draft.model),
      )?.label ?? draft.model.model);
  const kind = draft.kind;
  const currentOwnName =
    others.find((routine) => routine.id === draft.id)?.name ?? initialName;
  const rawNameProblem =
    draft.id && draft.name.trim() === currentOwnName
      ? undefined
      : routineNameProblem(draft.name, others, draft.id);
  const nameProblem =
    !draft.name.trim() && checked
      ? t("Enter a name.")
      : rawNameProblem === routineNameReserved
        ? t(rawNameProblem)
        : rawNameProblem
          ? formatText("A routine named “{name}” already exists.", {
              name: draft.name.trim(),
            })
          : undefined;
  const cron = kind === "custom" ? cronProblem(draft.cron) : undefined;
  const permissionTrigger =
    draft.permission === "auto"
      ? "Auto"
      : windowPermissionText[draft.permission].label;
  const pristine = Boolean(
    draft.id && !draft.duplicateOf && JSON.stringify(draft) === initialDraft,
  );
  const autoBlocked = autoOff && draft.permission === "auto";
  const now = Date.now();
  const past = oncePast(draft, now);
  const unavailable =
    !draft.model.default &&
    routineModelUnavailable(draft.model, settings.providers);
  const nameMissing = !draft.name.trim();
  const descriptionMissing = descriptionVisible && !draft.description.trim();
  const promptMissing = !draft.prompt.trim();
  const descriptionProblem =
    checked && descriptionMissing ? t("Enter a description.") : undefined;
  const promptProblem =
    checked && promptMissing ? t("Enter instructions.") : undefined;
  // What keeps Create disabled; missing fields are marked when it is pressed.
  const ready =
    (nameMissing || !nameProblem) &&
    !cron &&
    settings.providers.length > 0 &&
    !past &&
    !unavailable &&
    !autoBlocked &&
    // A GitHub event trigger listens to a repository.
    !(draft.triggers.github && !draft.triggers.github.repository);
  const displayedError = routineErrorText(error);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pendingSave.current || pristine) return;
    if (nameMissing || descriptionMissing || promptMissing) {
      setChecked(true);
      (nameMissing
        ? nameInput
        : descriptionMissing
          ? descriptionInput
          : promptInput
      ).current?.focus();
      return;
    }
    pendingSave.current = true;
    setBusy(true);
    setPicking(false);
    setError("");
    try {
      await onSave();
    } catch (reason) {
      if (!mounted.current) return;
      pendingSave.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }
  const scheduledTaskDialogViewView = scheduledTaskDialogView({
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
  });
  return scheduledTaskDialogViewView;
}
