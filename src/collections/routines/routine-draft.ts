import type { Schedule, Settings } from "../../../shared/types";
import type { TaskPermission } from "../../../shared/settings-extras";
import {
  frequencyFor,
  isCompletedOnce,
  nextRun,
  routineModelUnavailable,
  timeOf,
  type RepeatKind,
  type Routine,
  type RoutineAllowed,
  type RoutineInput,
  type RoutineRepeat,
} from "../../../shared/routines";
import { routineSavedPermission } from "../../../shared/routine-labels";
import { cronAsDays, cronForDays } from "../../../shared/cron";
import type { ModelChoice } from "./ModelPicker";
import type { RoutineTemplate } from "./routine-templates";
import type { RoutineTriggers } from "../../../shared/routine-triggers";
import type { RepositoryRef } from "../../../shared/host";

/** Everything the editor holds, with each schedule kind's last values kept. */
export interface RoutineDraft {
  id?: string;
  /**
   * The task this new one copies (Duplicate): the editor says so and the
   * save says "Scheduled task duplicated." Never saved.
   */
  duplicateOf?: string;
  name: string;
  description: string;
  /** False only when a hidden optional field was absent; explicit blank is data. */
  descriptionProvided?: boolean;
  prompt: string;
  mode: Schedule["mode"];
  cwd?: string;
  environment?: Routine["environment"];
  /** The project the routine is listed under. */
  projectId?: string;
  model: ModelChoice;
  /** The editor's segments; Custom is the cron expression. */
  kind: Exclude<RepeatKind, "cron">;
  time: string;
  minute: number;
  day: number;
  dayOfMonth: number;
  /** The weekdays a template or description named, kept until Custom is saved as cron. */
  days: number[];
  /** The Custom segment's cron expression. */
  cron: string;
  /** The One-time segment's moment (milliseconds); null while it is cleared. */
  at: number | null;
  /** The permission mode its runs use. */
  permission: TaskPermission;
  /** Approvals kept for its runs; the editor can remove them. */
  alwaysAllowed: RoutineAllowed[];
  revokedApprovals?: RoutineAllowed[];
  enabled: boolean;
  executionLocation?: Routine["executionLocation"];
  disableJitter?: boolean;
  notifyOnCompletion?: Routine["notifyOnCompletion"];
  /** Keeps a findings list (the Security review template). */
  securityReview?: boolean;
  /** What starts it besides Run now. */
  triggers: RoutineTriggers;
  /** Web Code: the repository and cloud environment its runs use. */
  repository?: RepositoryRef;
  cloudEnvironmentId?: string;
  /** Code: fix the checks and review comments of pull requests it opens. */
  autoFixPullRequests?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
/** The next whole hour after `now`. */
function nextHour(now: number) {
  const date = new Date(now);
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.getTime();
}

/** A `datetime-local` input's value ("2026-10-14T15:00") for a moment, in local time. */
export function toLocalInput(at: number | null): string {
  if (at === null) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The moment a `datetime-local` value names, in local time; null when empty or invalid. */
export function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Whether the One-time segment's moment cannot be saved: unset, or already past. */
export function oncePast(
  draft: Pick<RoutineDraft, "kind" | "at">,
  now: number,
) {
  return draft.kind === "once" && (draft.at === null || draft.at <= now);
}

/** A new routine: daily at 09:00, on the default model. */
export function newDraft(
  now: number,
  template?: RoutineTemplate,
  /** Code on this computer; the web runs a routine as a Cowork task. */
  mode: Schedule["mode"] = "code",
): RoutineDraft {
  const date = new Date(now);
  const base: RoutineDraft = {
    name: "",
    description: "",
    descriptionProvided: false,
    prompt: "",
    mode,
    model: { default: true },
    kind: "daily",
    // Daily at 09:00, as the original's new task.
    time: "09:00",
    minute: 0,
    day: date.getDay(),
    dayOfMonth: new Date(nextHour(now)).getDate(),
    days: [1, 2, 3, 4, 5],
    cron: "",
    // One-time: tomorrow at the hour of the daily default.
    at: nextHour(now) + DAY,
    // A new task runs on Auto where Auto is allowed; the editor falls back to
    // Manually approve when the administrator turned Auto off.
    permission: "auto",
    alwaysAllowed: [],
    enabled: true,
    disableJitter: false,
    // A new task notifies on completion, as the original's new routine does,
    // and as a saved task with no setting shows below.
    notifyOnCompletion: { push: true, email: false, slack: false },
    triggers: { schedule: true },
  };
  return template
    ? {
        ...base,
        ...draftRepeat(base, template.repeat),
        name: template.name,
        description: template.description,
        descriptionProvided: true,
        prompt: template.instructions,
        ...(template.securityReview ? { securityReview: true } : {}),
      }
    : base;
}

function draftRepeat(draft: RoutineDraft, repeat: RoutineRepeat) {
  // A cron rule, and a days rule from before cron, both open as Custom.
  const next: RoutineDraft = {
    ...draft,
    kind: repeat.kind === "cron" ? "custom" : repeat.kind,
  };
  if (repeat.kind === "hourly") next.minute = repeat.minute;
  if (repeat.kind === "once") next.at = repeat.at;
  if ("time" in repeat) next.time = repeat.time;
  if (repeat.kind === "weekly") next.day = repeat.day;
  if (repeat.kind === "monthly") next.dayOfMonth = repeat.dayOfMonth;
  if (repeat.kind === "custom") {
    next.days = repeat.days;
    next.cron = cronForDays(repeat.time, repeat.days);
  }
  if (repeat.kind === "cron") {
    next.cron = repeat.expression;
    const simple = cronAsDays(repeat.expression);
    if (simple) {
      next.time = simple.time;
      next.days = simple.days;
    }
  }
  return next;
}

/** An existing routine (or a task saved before routines) in the editor. */
export function editDraft(
  routine: Routine,
  repeat: RoutineRepeat,
  /** Settings tell what a Code routine saved before permission modes ran with. */
  settings?: Pick<
    Settings,
    | "codeSandbox"
    | "codePlanMode"
    | "autoAcceptEdits"
    | "bypassFolders"
    | "allowBypassPermissions"
  >,
): RoutineDraft {
  return draftRepeat(
    {
      id: routine.id,
      name: routine.name,
      description: routine.description ?? "",
      descriptionProvided: typeof routine.description === "string",
      prompt: routine.prompt,
      mode: routine.mode,
      cwd: routine.cwd,
      environment: routine.environment,
      projectId: routine.projectId,
      model: routine.defaultModel
        ? { default: true }
        : { providerId: routine.providerId, model: routine.model },
      kind: "daily",
      time: timeOf(routine.nextRunAt),
      minute: new Date(routine.nextRunAt).getMinutes(),
      day: new Date(routine.nextRunAt).getDay(),
      dayOfMonth: new Date(routine.nextRunAt).getDate(),
      days: [1, 2, 3, 4, 5],
      cron: "",
      at: nextHour(Date.now()) + DAY,
      permission:
        routine.permission ?? routineSavedPermission(routine, settings),
      alwaysAllowed: routine.alwaysAllowed ?? [],
      disableJitter: routine.disableJitter ?? true,
      notifyOnCompletion: routine.notifyOnCompletion ?? {
        push: true,
        email: false,
        slack: false,
      },
      // A one-time routine that has run is switched on again by a new moment.
      enabled: routine.enabled || isCompletedOnce(routine),
      executionLocation: routine.executionLocation,
      ...(routine.securityReview ? { securityReview: true } : {}),
      triggers: routine.triggers ?? { schedule: true },
      ...(routine.repository ? { repository: routine.repository } : {}),
      ...(routine.autoFixPullRequests ? { autoFixPullRequests: true } : {}),
      ...(routine.cloudEnvironmentId
        ? { cloudEnvironmentId: routine.cloudEnvironmentId }
        : {}),
    },
    repeat,
  );
}

export function draftRule(draft: RoutineDraft): RoutineRepeat {
  switch (draft.kind) {
    case "once":
      return { kind: "once", at: draft.at ?? 0 };
    case "manual":
      return { kind: "manual" };
    case "hourly":
      return { kind: "hourly", minute: draft.minute };
    case "weekly":
      return { kind: "weekly", time: draft.time, day: draft.day };
    case "monthly":
      return {
        kind: "monthly",
        time: draft.time,
        dayOfMonth: draft.dayOfMonth,
      };
    case "custom":
      return { kind: "cron", expression: draft.cron.trim() };
    default:
      return { kind: draft.kind, time: draft.time };
  }
}

/** What the scheduler is sent; "Default" is resolved by the main process. */
export function draftInput(
  draft: RoutineDraft,
  settings: Settings,
  now: number,
): RoutineInput {
  const repeat = draftRule(draft);
  const fallback =
    settings.providers.find((p) => p.id === settings.activeProviderId) ??
    settings.providers[0];
  const model =
    !draft.model.default &&
    !routineModelUnavailable(draft.model, settings.providers)
      ? draft.model
      : undefined;
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    ...(draft.descriptionProvided === false && !draft.description.trim()
      ? {}
      : { description: draft.description.trim() }),
    prompt: draft.prompt.trim(),
    mode: draft.mode,
    cwd: draft.cwd,
    environment: draft.environment,
    projectId: draft.projectId,
    providerId: model?.providerId ?? fallback?.id ?? "",
    model: model?.model ?? fallback?.model ?? "",
    defaultModel: model ? undefined : true,
    frequency: frequencyFor(repeat),
    nextRunAt:
      repeat.kind === "once" ? repeat.at : (nextRun(repeat, now) ?? now),
    enabled: draft.enabled,
    executionLocation: draft.executionLocation,
    repeat,
    permission: draft.permission,
    ...(draft.id
      ? { revokedApprovals: draft.revokedApprovals }
      : { alwaysAllowed: draft.alwaysAllowed }),
    disableJitter: draft.disableJitter,
    notifyOnCompletion: draft.notifyOnCompletion,
    ...(draft.securityReview ? { securityReview: true } : {}),
    // Only what is not the default goes: a task its schedule alone starts
    // keeps no triggers.
    ...(draft.triggers.schedule && !draft.triggers.api && !draft.triggers.github
      ? {}
      : { triggers: draft.triggers }),
    ...(draft.repository ? { repository: draft.repository } : {}),
    ...(draft.autoFixPullRequests && draft.mode === "code"
      ? { autoFixPullRequests: true }
      : {}),
    ...(draft.cloudEnvironmentId
      ? { cloudEnvironmentId: draft.cloudEnvironmentId }
      : {}),
  };
}

/**
 * A copy of a task as the original's Duplicate makes it: a new task with the
 * same instructions and schedule whose tools must be allowed again.
 */
export function duplicateDraft(
  draft: RoutineDraft,
  name: string,
): RoutineDraft {
  return {
    ...draft,
    id: undefined,
    duplicateOf: draft.id,
    name: name.slice(0, 500),
    alwaysAllowed: [],
    revokedApprovals: undefined,
  };
}
