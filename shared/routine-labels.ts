import type { Mode, Schedule, Settings } from "./types";
import type { TaskPermission } from "./settings-extras";
import { codeSandboxFor } from "./sandbox-policy";
import { cronAsDays } from "./cron";
import { weekdayNames, parseTime, timeOf } from "./routines";
import type { RoutineRepeat, RoutineFields } from "./routines";

/** The rule a task follows; an older task's comes from its anchor. */
export function repeatOf(
  task: Pick<Schedule, "frequency" | "nextRunAt"> & RoutineFields,
): RoutineRepeat {
  if (task.repeat) return task.repeat;
  const anchor = new Date(task.nextRunAt);
  if (task.frequency === "hourly")
    return { kind: "hourly", minute: anchor.getMinutes() };
  if (task.frequency === "weekly")
    return {
      kind: "weekly",
      time: timeOf(task.nextRunAt),
      day: anchor.getDay(),
    };
  return { kind: "daily", time: timeOf(task.nextRunAt) };
}

/** "9:05 AM", or "09:05 AM" with `padded` (the original's custom-day lines). */
export function formatClock(time: string, padded = false) {
  const { hours, minutes } = parseTime(time) ?? { hours: 0, minutes: 0 };
  const hour = String(hours % 12 || 12).padStart(padded ? 2 : 1, "0");
  return `${hour}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

function listDays(days: number[]) {
  const sorted = [...days].sort((a, b) => a - b);
  // Consecutive days read as a range: "Tuesday through Saturday".
  if (
    sorted.length >= 3 &&
    sorted.every((day, index) => !index || day === sorted[index - 1] + 1)
  )
    return `${weekdayNames[sorted[0]]} through ${weekdayNames[sorted.at(-1)!]}`;
  const names = sorted.map((day) => weekdayNames[day]);
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : names[0];
}

/** "Oct 14, 3:00 PM": a one-time routine's moment, in the viewer's language. */
export function onceTime(at: number, locale = "en-US") {
  return new Date(at).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Weekdays at 8:18 PM", "Every Tuesday at 2:16 AM", "At 01:49 AM, Tuesday through Saturday", "Manual", "Once on Oct 14, 3:00 PM". */
export function repeatLabel(repeat: RoutineRepeat, locale?: string): string {
  switch (repeat.kind) {
    case "manual":
      return "Manual";
    case "once":
      return `Once on ${onceTime(repeat.at, locale)}`;
    case "hourly":
      return `Hourly at :${String(repeat.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${formatClock(repeat.time)}`;
    case "weekdays":
      return `Weekdays at ${formatClock(repeat.time)}`;
    case "weekly":
      return `Every ${weekdayNames[repeat.day]} at ${formatClock(repeat.time)}`;
    case "monthly":
      return `At ${formatClock(repeat.time, true)}, on day ${repeat.dayOfMonth} of the month`;
    case "cron": {
      // A time of day on some weekdays reads like the other schedules.
      const simple = cronAsDays(repeat.expression);
      return simple
        ? repeatLabel({ kind: "custom", ...simple })
        : `Cron ${repeat.expression}`;
    }
    case "custom": {
      const days = [...new Set(repeat.days)];
      if (days.length === 7) return `Daily at ${formatClock(repeat.time)}`;
      if (days.length === 1)
        return `Every ${weekdayNames[days[0]]} at ${formatClock(repeat.time)}`;
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)))
        return `Weekdays at ${formatClock(repeat.time)}`;
      // "At 01:49 AM, …".
      return `At ${formatClock(repeat.time, true)}, ${listDays(days)}`;
    }
  }
}

export type RoutinePermission =
  "auto" | "manual" | "acceptEdits" | "plan" | "bypass";

/**
 * The permission mode a routine's run uses: the same Code setting as a
 * session started by hand in that folder (Bypass only where the person
 * confirmed it). The administrator's policy has no say over Bypass.
 * Undefined for Cowork routines, which follow the Cowork sandbox.
 */
export function routinePermission(
  settings: Pick<
    Settings,
    | "codeSandbox"
    | "codePlanMode"
    | "autoAcceptEdits"
    | "bypassFolders"
    | "allowBypassPermissions"
  >,
  mode: Mode,
  cwd?: string,
): RoutinePermission | undefined {
  if (mode !== "code") return undefined;
  if (settings.codePlanMode) return "plan";
  if (codeSandboxFor(settings, cwd) === "danger-full-access") return "bypass";
  if (settings.autoAcceptEdits) return "acceptEdits";
  return settings.codeSandbox === "read-only" ? "manual" : "auto";
}

export const permissionTitles: Record<RoutinePermission, string> = {
  auto: "Auto",
  manual: "Manual",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypass: "Bypass permissions",
};

/** One run of a routine, as its run history keeps it (newest first). */
export type RoutineRunTrigger = "schedule" | "manual" | "api" | "github";
export const routineRunTriggers: readonly RoutineRunTrigger[] = [
  "schedule",
  "manual",
  "api",
  "github",
];
export interface RoutineRun {
  id: string;
  startedAt: number;
  /** When the run's turn ended; absent while it runs or when it never started. */
  finishedAt?: number;
  status: NonNullable<Schedule["lastRunStatus"]> | "skipped";
  skipReason?: "missed" | "in_progress" | "busy" | "sign_in";
  readAt?: number;
  /** "schedule": started by its rule; "manual": Run now; "api": its fire
   * address was called; "github": a repository event it watches fired. */
  trigger: RoutineRunTrigger;
  error?: string;
  conversationId?: string;
}

/** How many runs each routine keeps in its history. */
export const routineRunLimit = 1000;

/** "Completed", "Failed", … for a run's status. */
export const runStatusLabels: Record<RoutineRun["status"], string> = {
  starting: "Running",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Failed",
  skipped: "Skipped",
};

/**
 * What a routine saved without a permission mode runs with: full access
 * for a Chat or Cowork task; for Code the folder's Code setting (Bypass or
 * asking). The detail page, the editor and the run read this one rule.
 */
export function routineSavedPermission(
  routine: Pick<Schedule, "mode" | "cwd">,
  settings?: Parameters<typeof routinePermission>[0],
): TaskPermission {
  if (routine.mode !== "code" || !settings) return "bypass";
  return routinePermission(settings, "code", routine.cwd) === "bypass"
    ? "bypass"
    : "default";
}

/** A run's length: "42s", "3m 05s", "1h 02m"; empty while it runs. */
export function runDuration(run: Pick<RoutineRun, "startedAt" | "finishedAt">) {
  if (run.finishedAt === undefined) return "";
  const seconds = Math.max(
    0,
    Math.round((run.finishedAt - run.startedAt) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
