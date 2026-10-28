import { routineEnvironmentKey } from "../../shared/routine-environment";
import { cleanRoutineTriggers } from "../../shared/routine-triggers";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { modeAllowed, modeRefusal } from "../../shared/client-policy";
import {
  allowedKey,
  defaultRoutinePermission,
  nextRun,
  routineLimitMessage,
  routineNameProblem,
  routinesOffMessage,
  validAllowed,
  type Routine,
  type RoutineInput,
} from "../../shared/routines";
import { type MigrationStoredRoutine } from "./routine-migration-journal";
import type { Scheduler } from "./scheduler";
import {
  nextOccurrence,
  validate,
  routineOncePastMessage,
  routineJitterSeconds,
} from "./scheduler-support";

export function saveTask(
  this: Scheduler,
  input: RoutineInput,
  origin?: { setupConversationId?: string; migrationImportKey?: string },
): Routine {
  if (origin?.setupConversationId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(origin.setupConversationId) || input.id)
      throw new Error("Invalid scheduled task setup origin.");
    const same = this.schedules.find(
      (task) => task.setupConversationId === origin.setupConversationId,
    );
    if (same) {
      this.assertMigrationUnlocked(same.id);
      return structuredClone(this.listedTask(same));
    }
  }
  const fields = validate(input);
  const existing = fields.id
    ? this.schedules.find((task) => task.id === fields.id)
    : undefined;
  if (fields.id && !existing)
    throw new Error("This scheduled task no longer exists.");
  if (existing) this.assertMigrationUnlocked(existing.id);
  if (
    existing?.endedReason === "auto_disabled_repo_access" &&
    fields.enabled &&
    fields.mode === "code" &&
    routineEnvironmentKey(fields.environment) === "local"
  ) {
    try {
      if (!fields.cwd) throw new Error("Missing workspace folder");
      fs.accessSync(fields.cwd, fs.constants.R_OK | fs.constants.X_OK);
      if (!fs.statSync(fields.cwd).isDirectory())
        throw new Error("Workspace is not a directory");
    } catch {
      throw new Error(
        "Restore access to this task’s workspace folder before turning it back on.",
      );
    }
  }
  if (!existing && fields.permission === undefined)
    fields.permission = defaultRoutinePermission;
  // The editor checks too; this keeps the rule for anything that skips it.
  // A routine saved before the rule keeps its name (pausing it must work).
  const nameProblem =
    existing?.name === fields.name
      ? undefined
      : routineNameProblem(fields.name, this.schedules, existing?.id);
  if (nameProblem) throw new Error(nameProblem);
  // The administrator can turn Auto off; a routine is not saved on it (one
  // saved before keeps it for pausing and renaming).
  const policy = this.options.policy?.();
  if (
    fields.permission === "auto" &&
    existing?.permission !== "auto" &&
    policy &&
    !modeAllowed(policy, "auto")
  )
    throw new Error(modeRefusal("auto"));
  if (!existing) {
    const limits = this.options.policy?.().scheduledTasks;
    if (limits?.enabled === false) throw new Error(routinesOffMessage);
    if (
      typeof limits?.maxTasks === "number" &&
      this.schedules.length >= limits.maxTasks
    )
      throw new Error(routineLimitMessage(limits.maxTasks));
  }
  if (!existing && this.schedules.length >= 1000)
    throw new Error("You can save up to 1,000 scheduled tasks.");
  const now = this.now();
  // A routine's next slot always comes from its rule.
  if (fields.repeat?.kind === "once") {
    // One slot: its moment. A new routine, a changed moment and a routine
    // that already ran must be given a moment that has not passed; one that
    // is merely waiting for the app to open (its moment passed while it was
    // closed) keeps it and runs once on open.
    const at = fields.repeat.at;
    const before = existing?.repeat;
    const same = before?.kind === "once" && before.at === at;
    const ran =
      same && existing?.lastRunAt !== undefined && existing.lastRunAt >= at;
    // Switching a paused routine on is choosing to run it, so it needs a
    // moment ahead as well.
    const switchingOn = existing !== undefined && !existing.enabled;
    if (fields.enabled && at <= now && (!same || ran || switchingOn))
      throw new Error(routineOncePastMessage);
    fields.nextRunAt = at;
  } else if (fields.repeat) {
    const next = nextRun(fields.repeat, now);
    if (fields.repeat.kind === "cron" && next === undefined)
      throw new Error("No upcoming run for this schedule.");
    fields.nextRunAt = next ?? existing?.nextRunAt ?? now;
  }
  // An editor opened before a run may submit the old due time after its slot was reserved.
  if (
    existing?.lastRunAt !== undefined &&
    fields.nextRunAt <= existing.lastRunAt
  )
    fields.nextRunAt = nextOccurrence(fields, now);
  const task: MigrationStoredRoutine = {
    ...existing,
    connectionHold: existing?.connectionHold,
    endedReason: fields.enabled ? undefined : existing?.endedReason,
    // A field the form leaves out (a cleared description) is dropped.
    description: undefined,
    repeat: undefined,
    defaultModel: undefined,
    securityReview: undefined,
    projectId: undefined,
    permission: undefined,
    triggers: undefined,
    repository: undefined,
    cloudEnvironmentId: undefined,
    autoFixPullRequests: undefined,
    // Kept unless the form sent a list; changing where it runs clears it.
    alwaysAllowed: existing?.alwaysAllowed,
    ...fields,
    id: existing?.id ?? randomUUID(),
    ...(origin?.setupConversationId
      ? { setupConversationId: origin.setupConversationId }
      : {}),
    ...(origin?.migrationImportKey
      ? { migrationImportKey: origin.migrationImportKey }
      : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (
    existing &&
    ((existing.cwd ?? "") !== (task.cwd ?? "") ||
      routineEnvironmentKey(existing.environment) !==
        routineEnvironmentKey(task.environment) ||
      (existing.executionLocation ?? "local") !==
        (task.executionLocation ?? "local") ||
      existing.mode !== task.mode)
  ) {
    task.alwaysAllowed = undefined;
    task.browserGrant = undefined;
    task.browserGrantRevision = (existing.browserGrantRevision ?? 0) + 1;
  }
  if (input.revokedApprovals !== undefined) {
    const revoked = validAllowed(input.revokedApprovals);
    task.alwaysAllowed = task.alwaysAllowed?.filter(
      (entry) =>
        !revoked.some((removed) => allowedKey(entry) === allowedKey(removed)),
    );
  }
  if (!task.alwaysAllowed?.length) delete task.alwaysAllowed;
  // The token hint is the service's: kept while the API trigger stays.
  if (task.triggers)
    task.triggers = cleanRoutineTriggers(task.triggers, existing?.triggers);
  for (const key of [
    "triggers",
    "repository",
    "cloudEnvironmentId",
    "autoFixPullRequests",
  ] as const)
    if (task[key] === undefined) delete task[key];
  task.dispatchJitterSeconds = routineJitterSeconds(task, now);
  this.commit(
    existing
      ? this.schedules.map((value) => (value.id === task.id ? task : value))
      : [...this.schedules, task],
  );
  return structuredClone(this.listedTask(task));
}
