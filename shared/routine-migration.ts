import type {
  Routine,
  RoutineBackend,
  RoutineCapabilities,
  RoutineInput,
} from "./routines";
import { repeatOf } from "./routine-labels";
import { cronProblem, parseCron } from "./cron";

export interface RoutineMigrationBackendCapabilities {
  import?: boolean;
  deleteHistory?: boolean;
  originLock?: boolean;
  timeZone?: string;
  models: { providerId: string; model: string }[];
  defaultModel?: { providerId: string; model: string };
}
export interface RoutineMigrationImportInput {
  key: string;
  task: RoutineInput;
}
export interface RoutineMigrationDeleteInput {
  key: string;
  id: string;
}
export interface RoutineMigrationDeleteResult {
  deleted: true;
  historyDeleted: true;
}
export interface RoutineMigrationBeginInput {
  key: string;
  id: string;
  expectedUpdatedAt: number;
}
export interface RoutineMigrationBeginResult {
  task: Routine;
}
export interface RoutineMigrationRestoreInput {
  key: string;
  id: string;
  prompt: string;
}
export interface RoutineMigrationRequest {
  id: string;
  direction: "to-cloud" | "to-local";
}
export interface RoutineMigrationResult {
  task: Routine;
  fromId: string;
  toId: string;
  history: "local-retained" | "cloud-deleted";
}
export type RoutineMigrationReason =
  | "unavailable"
  | "missing"
  | "paused"
  | "running"
  | "no_prompt"
  | "local_folders"
  | "projects"
  | "space"
  | "chrome"
  | "cwd"
  | "dispatch_hook"
  | "pattern_approvals"
  | "sub_hourly"
  | "custom_cron"
  | "source"
  | "model"
  | "not_origin"
  | "origin_missing"
  | "expired_once"
  | "timezone";
export interface RoutineMigrationCheck {
  ok: boolean;
  reasons: RoutineMigrationReason[];
}
export interface RoutineMigrationEligibility {
  source: RoutineBackend;
  toCloud: RoutineMigrationCheck;
  toLocal: RoutineMigrationCheck;
  /** A pending move retries its durable key; it does not create another copy. */
  pending?: boolean;
}

export function migrationCapabilities(
  value: RoutineCapabilities | undefined,
): RoutineMigrationBackendCapabilities | undefined {
  const migration = (
    value as
      | (RoutineCapabilities & {
          migration?: RoutineMigrationBackendCapabilities;
        })
      | undefined
  )?.migration;
  if (
    !migration ||
    !Array.isArray(migration.models) ||
    migration.models.some(
      (model) =>
        !model ||
        typeof model.providerId !== "string" ||
        typeof model.model !== "string",
    )
  )
    return undefined;
  return migration;
}

/** O16 shared-1:4626–4668: do not silently discard unsupported local state.
 * Claudex has no remote file/project migration protocol, so neither is opted in. */
export function routineMigrationReasons(
  task: Routine,
  now = Date.now(),
): RoutineMigrationReason[] {
  const reasons: RoutineMigrationReason[] = [];
  const raw = task as Routine & Record<string, unknown>;
  if (!task.prompt?.trim()) reasons.push("no_prompt");
  if (!task.enabled) reasons.push("paused");
  if (["starting", "running"].includes(task.lastRunStatus ?? ""))
    reasons.push("running");
  if (
    [
      raw.userSelectedFolders,
      raw.userSelectedFiles,
      raw.additionalFolders,
    ].some((value) => Array.isArray(value) && value.length)
  )
    reasons.push("local_folders");
  if (
    task.projectId ||
    (Array.isArray(raw.userSelectedProjectUuids) &&
      raw.userSelectedProjectUuids.length)
  )
    reasons.push("projects");
  if (task.environment?.kind === "space" || raw.spaceId) reasons.push("space");
  if (
    raw.chromePermissionMode ||
    (Array.isArray(raw.chromeAllowedDomains) && raw.chromeAllowedDomains.length)
  )
    reasons.push("chrome");
  if (
    task.cwd ||
    (task.environment && task.environment.kind !== "local") ||
    raw.place ||
    raw.useWorktree ||
    raw.sourceBranch
  )
    reasons.push("cwd");
  if (raw.dispatchSubscribed) reasons.push("dispatch_hook");
  if (
    task.alwaysAllowed?.some((approval) => Boolean(approval.pattern)) ||
    (Array.isArray(raw.approvedPermissions) &&
      raw.approvedPermissions.some(
        (approval) =>
          approval &&
          typeof approval === "object" &&
          "ruleContent" in approval &&
          Boolean(approval.ruleContent),
      ))
  )
    reasons.push("pattern_approvals");
  const repeat = repeatOf(task);
  if (repeat.kind === "cron") {
    const minute = repeat.expression.trim().split(/\s+/)[0];
    if (minute && /[*/,-]/.test(minute)) reasons.push("sub_hourly");
    else if (cronProblem(repeat.expression)) reasons.push("custom_cron");
    else {
      const parsed = parseCron(repeat.expression);
      const fields = repeat.expression.trim().split(/\s+/);
      const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (
        (fields[2] !== "*" && fields[4] !== "*") ||
        !parsed.months.some((month) =>
          parsed.days.some((day) => day <= monthDays[month - 1]),
        )
      )
        reasons.push("custom_cron");
    }
  } else if (repeat.kind === "manual") reasons.push("custom_cron");
  if (repeat.kind === "once" && repeat.at <= now) reasons.push("expired_once");
  return [...new Set(reasons)];
}

export function migrationTargetReasons(
  task: Routine,
  capabilities: RoutineCapabilities | undefined,
): RoutineMigrationReason[] {
  const supported = migrationCapabilities(capabilities);
  const reasons: RoutineMigrationReason[] = [];
  if (!supported) return ["unavailable"];
  if (!capabilities?.sources?.includes(task.mode === "code" ? "code" : "chat"))
    reasons.push("source");
  if (
    task.defaultModel
      ? !supported.defaultModel
      : !supported.models.some(
          (model) =>
            model.providerId === task.providerId && model.model === task.model,
        )
  )
    reasons.push("model");
  return reasons;
}

/** No per-task zone protocol exists yet. A one-time timestamp is absolute;
 * repeating rules must not silently adopt another machine’s wall clock. */
export function migrationTimeZoneReasons(
  task: Routine,
  source?: string,
  target?: string,
): RoutineMigrationReason[] {
  return repeatOf(task).kind === "once" ||
    (source && target && source === target)
    ? []
    : ["timezone"];
}
