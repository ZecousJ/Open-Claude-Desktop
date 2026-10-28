import type { RoutineBrowserGrant } from "./routine-browser";
/**
 * Routines: the repeat rule, description and model choice a scheduled task
 * keeps next to the fields in `shared/types.ts`. The local scheduler
 * (`electron/scheduler.ts`) stores them with the task; a task saved before
 * routines has no rule and keeps its hourly/daily/weekly anchor, which
 * `repeatOf` describes in the same terms.
 */
import type {
  Schedule,
  ScheduleFrequency,
  ScheduleInput,
  Settings,
} from "./types";
import type { TaskPermission } from "./settings-extras";
import { cronProblem, cronProblemMessages, nextCron, parseCron } from "./cron";
import { type RoutineRun } from "./routine-labels";

/** A local "HH:MM" time with Sunday = 0 weekdays, as `Date#getDay`. */
export type RoutineRepeat =
  | { kind: "manual" }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; time: string; day: number }
  | { kind: "monthly"; time: string; dayOfMonth: number }
  | { kind: "custom"; time: string; days: number[] }
  /** A five-field cron expression (shared/cron.ts): what the editor's Custom takes. */
  | { kind: "cron"; expression: string }
  /**
   * One run at an exact moment (`at`, milliseconds since the epoch: the same
   * instant on every device), after which the routine switches itself off.
   */
  | { kind: "once"; at: number };
export type RepeatKind = RoutineRepeat["kind"];

/**
 * One approval a person chose to keep allowing for a routine ("Always allow
 * for this task"): the kind of action, what it was and, for a command or a
 * tool, the pattern that matches later requests.
 */
export interface RoutineAllowed {
  kind: "command" | "edit" | "permission" | "tool";
  /** The tool or action named in the list ("Run command", "Edit files", a connector tool). */
  tool: string;
  /** The exact command, folder or tool arguments that were allowed. */
  pattern?: string;
  approvedAt?: number;
  expired?: boolean;
}

export interface RoutineFields {
  /** Backend-owned: ordinary saves cannot create or replace Browser approvals. */
  browserGrant?: RoutineBrowserGrant;
  browserGrantRevision?: number;
  connectionHold?: import("./task-connection-hold").TaskConnectionHold;
  endedReason?: "auto_disabled_repo_access";
  executionLocation?: "local" | "remote";
  disableJitter?: boolean;
  notifyOnCompletion?: { push: boolean; email: boolean; slack: boolean };
  dispatchJitterSeconds?: number;
  lastRunSummary?: string;
  lastRunNotify?: boolean;
  /** One line saying what the routine is for. */
  description?: string;
  repeat?: RoutineRepeat;
  /**
   * The permission mode its runs use: Manual asks the person for each action
   * (the run waits for an answer), Auto lets Codex's reviewer decide, Skip all
   * approvals never asks. A routine without one keeps what it always did: full
   * access for Cowork, the Code setting for Code.
   */
  permission?: TaskPermission;
  /** Approvals kept for this routine's later runs (Manual and Auto only). */
  alwaysAllowed?: RoutineAllowed[];
  /**
   * Runs on the active connection's default model and follows it when the
   * default changes in Settings.
   */
  defaultModel?: boolean;
  /**
   * What starts it besides Run now: its schedule (unless switched off), a call
   * to its fire address, an event of a GitHub repository. Missing: its
   * schedule alone.
   */
  triggers?: import("./routine-triggers").RoutineTriggers;
  /** Web Code: the repository each run's cloud session starts with. */
  repository?: import("./host").RepositoryRef;
  /** Web Code: the cloud environment its runs use. */
  cloudEnvironmentId?: string;
  /**
   * Code: a pull request a run opens is watched, and its failing checks and
   * review comments go back to the run's session to fix (the session's
   * prAutoFix, electron/git/pr-autofix.ts).
   */
  autoFixPullRequests?: boolean;
  /**
   * Reviews its folder's branch for vulnerabilities on its schedule and keeps
   * the findings as a list (shared/security-review.ts); set by the Security
   * review template.
   */
  securityReview?: boolean;
}
export type RoutineInput = ScheduleInput &
  RoutineFields & { revokedApprovals?: RoutineAllowed[] };
export type Routine = Schedule &
  RoutineFields & {
    /** Read-only facts computed by the backend that owns this schedule. */
    listMetadata?: RoutineListMetadata;
    /** Backend-only durable idempotency key for an explicit Chat setup. */
    setupConversationId?: string;
    /** Known execution records on the scheduler; absent if legacy history is unavailable. */
    runCount?: number;
    /** The retained history reached its cap: runCount is a lower bound. */
    runCountLimited?: boolean;
  };

export interface RoutineListMetadata {
  device?: {
    id?: string;
    name?: string;
    connectivity: "connected" | "offline" | "unknown";
  };
  provenance?: { backend: RoutineBackend; deviceId?: string };
  source: "chat" | "code";
  host?: "this-computer" | "another-computer" | "local-only" | "ssh" | "cloud";
  attention: {
    unread: number;
    awaiting: number;
    failed: number;
    conversationIds: string[];
  };
}
export type RoutineBackend = "local" | "remote";
export interface RoutineSourceState {
  source: RoutineBackend;
  status: "ready" | "error" | "refused";
  message?: string;
}
export interface RoutineListResult {
  tasks: Routine[];
  sources: RoutineSourceState[];
}
export function validRoutineListResult(
  value: unknown,
): value is RoutineListResult {
  if (!value || typeof value !== "object") return false;
  const result = value as RoutineListResult;
  return (
    Array.isArray(result.tasks) &&
    result.tasks.every(
      (task) =>
        task && typeof task.id === "string" && typeof task.name === "string",
    ) &&
    Array.isArray(result.sources) &&
    result.sources.length > 0 &&
    result.sources.every(
      (source) =>
        source &&
        ["local", "remote"].includes(source.source) &&
        ["ready", "error", "refused"].includes(source.status),
    )
  );
}
export type RoutineDetailResult =
  | { status: "ready"; task: Routine }
  | { status: "missing" }
  | { status: "error" | "refused"; message?: string };

/** Only structured permission failures are refusals; network errors are retryable. */
export function routineReadFailure(error: unknown): "error" | "refused" {
  const value = error as { code?: unknown; status?: unknown } | null;
  return value?.status === 403 ||
    value?.code === 403 ||
    [
      "403",
      "FORBIDDEN",
      "PERMISSION_DENIED",
      "CLAUDEX_POLICY_DENIED",
      "CLAUDEX_WEB_NOT_ALLOWED",
    ].includes(String(value?.code))
    ? "refused"
    : "error";
}

export interface RoutineCapabilities {
  migration?: import("./routine-migration").RoutineMigrationBackendCapabilities;
  /** Explicit setup tool is installed on the owned Chat runtime. */
  setupWithChat?: boolean;
  statuses?: ("active" | "paused" | "auto-disabled" | "on-hold")[];
  /** Sources the executing scheduler actually supports; Chat uses its Cowork runtime. */
  sources?: ("chat" | "code")[];
  remote: boolean;
  computerName?: string;
  email: boolean;
  slack: boolean;
}

/** Server-side history pagination; cursors are opaque to the renderer. */
export interface RoutineRunQuery {
  cursor?: string;
  limit?: number;
}
export interface RoutineRunPage {
  runs: RoutineRun[];
  nextCursor?: string;
}
/** Computed on the computer that will actually execute the schedule. */
export interface RoutineSchedulePreview {
  nextRunAt: number | null;
  timeZone?: string;
}

/** Unavailable model notices. */
export const unavailableRoutineModel = {
  local:
    "This task’s model is no longer available. It runs on your default model until you choose another.",
  remote:
    "This task’s model is no longer available. Choose another model to keep it running.",
};

export function routineModelUnavailable(
  task: Pick<Routine, "defaultModel" | "providerId" | "model">,
  providers: Settings["providers"],
) {
  if (task.defaultModel) return false;
  return !providers.some(
    (provider) =>
      provider.id === task.providerId &&
      [provider.model, ...(provider.models ?? [])].includes(task.model),
  );
}

export function routineRunModel(
  task: Routine,
  settings: Settings,
  source: "local" | "remote",
) {
  const unavailable = routineModelUnavailable(task, settings.providers);
  if (unavailable && source === "remote")
    throw new Error(unavailableRoutineModel.remote);
  if (!task.defaultModel && !unavailable) return task;
  const provider =
    settings.providers.find(
      (value) => value.id === settings.activeProviderId,
    ) ?? settings.providers[0];
  if (!provider?.model) throw new Error(unavailableRoutineModel[source]);
  return { ...task, providerId: provider.id, model: provider.model };
}

/** The editor's segments; its Custom is a cron expression (a `custom` rule from before reads as one). */
export const repeatKinds: Exclude<RepeatKind, "cron">[] = [
  "custom",
  "once",
  "manual",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
];

/** Local names. */
export function localRoutineName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 120)
    .replace(/[-_]+$/, "");
}
export const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Names a routine cannot take. */
const reservedNames = ["new", "new-local"];
export const routineNameReserved =
  "This name is reserved. Choose a different name.";
export const routineNameTaken = (name: string) =>
  `A routine named “${name}” already exists.`;

/**
 * Why a routine cannot be called `name`: it is reserved, or another routine
 * (not the one with `ownId`) already has it, ignoring case. Undefined when
 * the name is fine.
 */
export function routineNameProblem(
  name: string,
  others: Pick<Schedule, "id" | "name">[],
  ownId?: string,
): string | undefined {
  const wanted = name.trim().toLowerCase();
  if (reservedNames.includes(wanted)) return routineNameReserved;
  if (
    others.some(
      (task) => task.id !== ownId && task.name.trim().toLowerCase() === wanted,
    )
  )
    return routineNameTaken(name.trim());
  return undefined;
}

/** Shown where a routine cannot be created or run while the policy says so. */
/** The service turned scheduled tasks off. */
export const routinesOffMessage =
  "Scheduled tasks aren’t turned on for your account.";
export const routineLimitMessage = (limit: number) =>
  `Your administrator allows up to ${limit} routine${limit === 1 ? "" : "s"}.`;

export const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(time: string) {
  const match = clock.exec(time);
  return match ? { hours: +match[1], minutes: +match[2] } : undefined;
}

export function timeOf(timestamp: number) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Checks a rule from the window or from disk; the error says what is wrong. */
export function validRepeat(value: unknown): RoutineRepeat {
  const rule = value as Partial<Record<string, unknown>> | null;
  if (!rule || typeof rule !== "object" || typeof rule.kind !== "string")
    throw new Error("Choose when the routine runs.");
  const time = () => {
    if (typeof rule.time !== "string" || !parseTime(rule.time))
      throw new Error("Choose a valid time.");
    return rule.time;
  };
  const day = (value: unknown) => {
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (value as number) > 6
    )
      throw new Error("Choose a valid day.");
    return value as number;
  };
  switch (rule.kind) {
    case "manual":
      return { kind: "manual" };
    case "hourly":
      if (
        !Number.isInteger(rule.minute) ||
        (rule.minute as number) < 0 ||
        (rule.minute as number) > 59
      )
        throw new Error("Choose a minute between 0 and 59.");
      return { kind: "hourly", minute: rule.minute as number };
    case "daily":
    case "weekdays":
      return { kind: rule.kind, time: time() };
    case "weekly":
      return { kind: "weekly", time: time(), day: day(rule.day) };
    case "monthly":
      if (
        !Number.isInteger(rule.dayOfMonth) ||
        (rule.dayOfMonth as number) < 1 ||
        (rule.dayOfMonth as number) > 31
      )
        throw new Error("Choose a valid day.");
      return {
        kind: "monthly",
        time: time(),
        dayOfMonth: rule.dayOfMonth as number,
      };
    case "custom": {
      if (!Array.isArray(rule.days) || !rule.days.length)
        throw new Error("Choose at least one day.");
      const days = [...new Set(rule.days.map(day))].sort((a, b) => a - b);
      return { kind: "custom", time: time(), days };
    }
    case "once":
      if (
        typeof rule.at !== "number" ||
        !Number.isFinite(rule.at) ||
        !Number.isFinite(new Date(rule.at).getTime())
      )
        throw new Error("Choose a valid time.");
      // Whole minutes, as the editors pick them.
      return { kind: "once", at: Math.floor(rule.at / 60_000) * 60_000 };
    case "cron": {
      if (typeof rule.expression !== "string")
        throw new Error(cronProblemMessages.invalid);
      const problem = cronProblem(rule.expression);
      if (problem) throw new Error(cronProblemMessages[problem]);
      return { kind: "cron", expression: rule.expression.trim() };
    }
    default:
      throw new Error("Choose when the routine runs.");
  }
}

/** The older field kept in step with the rule (notifications and exports read it). */
export function frequencyFor(repeat: RoutineRepeat): ScheduleFrequency {
  if (repeat.kind === "hourly") return "hourly";
  if (repeat.kind === "once") return "daily";
  // A cron schedule runs at most hourly: every hour when its hour field is open.
  if (repeat.kind === "cron")
    return parseCron(repeat.expression).hours.length === 24
      ? "hourly"
      : "daily";
  if (repeat.kind === "weekly") return "weekly";
  return "daily";
}

const allDays = [0, 1, 2, 3, 4, 5, 6];
function daysOf(repeat: RoutineRepeat) {
  if (repeat.kind === "weekdays") return [1, 2, 3, 4, 5];
  if (repeat.kind === "weekly") return [repeat.day];
  if (repeat.kind === "custom") return repeat.days;
  return allDays;
}

/**
 * The first run strictly after `after`, in the computer's local time (so a
 * 9:00 routine stays at 9:00 across daylight-saving changes); undefined for
 * a routine that only runs when started.
 */
/**
 * When the runner must wake a user's scheduled tasks: the earliest due time
 * of a task that starts by itself (an enabled one that is not manual), or
 * undefined when none does.
 */
export function nextWakeAt(
  tasks: Pick<
    Routine,
    | "enabled"
    | "repeat"
    | "nextRunAt"
    | "dispatchJitterSeconds"
    | "connectionHold"
    | "triggers"
  >[],
): number | undefined {
  let at: number | undefined;
  for (const task of tasks) {
    if (!task.enabled || task.connectionHold || scheduleOff(task)) continue;
    const due = routineDispatchAt(task);
    if (at === undefined || due < at) at = due;
  }
  return at;
}

export function routineDispatchAt(
  task: Pick<Routine, "nextRunAt" | "dispatchJitterSeconds">,
): number {
  return task.nextRunAt + (task.dispatchJitterSeconds ?? 0) * 1000;
}

export function nextRun(repeat: RoutineRepeat, after: number) {
  if (repeat.kind === "manual") return undefined;
  // A one-time routine has one slot, gone once it has passed.
  if (repeat.kind === "once") return repeat.at > after ? repeat.at : undefined;
  if (repeat.kind === "cron") return nextCron(repeat.expression, after);
  if (repeat.kind === "hourly") {
    const date = new Date(after);
    date.setMinutes(repeat.minute, 0, 0);
    while (date.getTime() <= after) date.setHours(date.getHours() + 1);
    return date.getTime();
  }
  const { hours, minutes } = parseTime(repeat.time)!;
  if (repeat.kind === "monthly") {
    const anchor = new Date(after);
    for (let offset = 0; offset <= 12; offset++) {
      const date = new Date(
        anchor.getFullYear(),
        anchor.getMonth() + offset,
        repeat.dayOfMonth,
        hours,
        minutes,
      );
      if (date.getDate() === repeat.dayOfMonth && date.getTime() > after)
        return date.getTime();
    }
    return undefined;
  }
  const days = daysOf(repeat);
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(after);
    date.setDate(date.getDate() + offset);
    date.setHours(hours, minutes, 0, 0);
    if (days.includes(date.getDay()) && date.getTime() > after)
      return date.getTime();
  }
  return undefined;
}

type RunState = Pick<
  Routine,
  "repeat" | "enabled" | "lastRunAt" | "lastRunStatus"
>;

/**
 * A one-time routine that has had its run: it switched itself off at its
 * moment and its run is no longer going. It waits in the list's Completed
 * section until a new moment is chosen. A run started by hand before the
 * moment does not complete it.
 */
export function isCompletedOnce(task: RunState): boolean {
  const repeat = task.repeat;
  return (
    repeat?.kind === "once" &&
    !task.enabled &&
    task.lastRunAt !== undefined &&
    task.lastRunAt >= repeat.at &&
    task.lastRunStatus !== "starting" &&
    task.lastRunStatus !== "running"
  );
}

/** The list's sections: what runs on its own, what is paused, what finished. */
export function routineSections<T extends RunState>(tasks: T[]) {
  const sections = {
    active: [] as T[],
    inactive: [] as T[],
    completed: [] as T[],
  };
  for (const task of tasks)
    sections[
      isCompletedOnce(task) ? "completed" : task.enabled ? "active" : "inactive"
    ].push(task);
  return sections;
}

/** New tasks ask by default. */
export const defaultRoutinePermission: TaskPermission = "default";

/** The permission mode a routine's runs use. */
export const taskPermissionOf = (
  task: Pick<RoutineFields, "permission">,
): TaskPermission => task.permission ?? "bypass";

/** Checks an "Always allowed" list from the window or from disk. */
export function validAllowed(value: unknown): RoutineAllowed[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error("Invalid list of allowed actions.");
  const kinds = ["command", "edit", "permission", "tool"];
  const seen = new Set<string>();
  const result: RoutineAllowed[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !kinds.includes(entry.kind) ||
      typeof entry.tool !== "string" ||
      !entry.tool.trim() ||
      entry.tool.length > 200 ||
      (entry.pattern !== undefined &&
        (typeof entry.pattern !== "string" || entry.pattern.length > 2000))
    )
      throw new Error("Invalid list of allowed actions.");
    const key = allowedKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      kind: entry.kind,
      tool: entry.tool.trim(),
      ...(entry.pattern ? { pattern: entry.pattern } : {}),
      ...(Number.isFinite(entry.approvedAt)
        ? { approvedAt: entry.approvedAt }
        : {}),
    });
  }
  return result;
}

export const allowedKey = (entry: RoutineAllowed) =>
  `${entry.kind}\u0000${entry.tool}\u0000${entry.pattern ?? ""}`;

/** Whether time never starts the task: Manual, or its schedule switched off
 * because another trigger starts it. */
export function scheduleOff(
  task: Pick<RoutineFields, "repeat" | "triggers">,
): boolean {
  return task.repeat?.kind === "manual" || task.triggers?.schedule === false;
}
