import fs from "node:fs";
import { modeAllowed, modeRefusal } from "../../shared/client-policy";
import {
  defaultRoutinePermission,
  routineLimitMessage,
  routineNameProblem,
  routinesOffMessage,
  type Routine,
  type RoutineInput,
} from "../../shared/routines";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import type {
  RoutineMigrationBeginInput,
  RoutineMigrationBeginResult,
  RoutineMigrationRestoreInput,
  RoutineMigrationImportInput,
  RoutineMigrationDeleteInput,
  RoutineMigrationDeleteResult,
} from "../../shared/routine-migration";
import {
  checkedMigrationKey,
  checkedMigrationId,
  type MigrationStoredRoutine,
} from "./routine-migration-journal";
import type { Scheduler } from "./scheduler";
import {
  routineMigrationLockedMessage,
  migrationNotCreated,
  validate,
  routineOncePastMessage,
} from "./scheduler-support";

export function migrationBlocked(this: Scheduler, id: string): boolean {
  if (this.migrations.deleted(id)) return true;
  const origin = this.migrations.latestOrigin(id);
  const task = this.schedules.find((entry) => entry.id === id) as
    MigrationStoredRoutine | undefined;
  return origin?.state === "locked" && task?.migrationRestoreKey !== origin.key;
}

export function assertMigrationUnlocked(this: Scheduler, id: string): void {
  if (this.migrationBlocked(id)) throw new Error(routineMigrationLockedMessage);
}

export function assertMigrationIdle(this: Scheduler, task: Routine): void {
  if (
    this.dispatch?.taskId === task.id ||
    this.activeRuns.has(task.id) ||
    ["starting", "running"].includes(task.lastRunStatus ?? "")
  )
    throw new Error(
      "This scheduled task is running. Try again when it finishes.",
    );
}

/** O16 durable key per origin move. */
export function beginMigration(
  this: Scheduler,
  input: RoutineMigrationBeginInput,
): RoutineMigrationBeginResult {
  const key = checkedMigrationKey(input?.key),
    id = checkedMigrationId(input?.id);
  const previous = this.migrations.get(key);
  if (previous) {
    if (previous.kind !== "origin" || previous.id !== id)
      throw new Error("This migration key belongs to a different task.");
    if (previous.state === "locked") {
      const task = this.schedules.find((entry) => entry.id === id) as
        MigrationStoredRoutine | undefined;
      if (!task) throw new Error("This scheduled task no longer exists.");
      if (task.migrationRestoreKey !== key && task.enabled)
        this.commit(
          this.schedules.map((entry) =>
            entry.id === id
              ? { ...entry, enabled: false, updatedAt: this.now() }
              : entry,
          ),
        );
    }
    return { task: structuredClone(previous.task) };
  }
  const task = this.schedules.find((entry) => entry.id === id);
  if (!task) throw new Error("This scheduled task no longer exists.");
  this.assertMigrationUnlocked(id);
  this.assertMigrationIdle(task);
  if (
    !Number.isFinite(input.expectedUpdatedAt) ||
    task.updatedAt !== input.expectedUpdatedAt
  )
    throw new Error("This task changed. Refresh it before moving it.");
  if (!task.enabled)
    throw new Error("Turn on this scheduled task before moving it.");
  const original = structuredClone(this.listedTask(task));
  this.migrations.put({
    key,
    kind: "origin",
    id,
    state: "locked",
    task: original,
  });
  this.commit(
    this.schedules.map((entry) =>
      entry.id === id
        ? { ...entry, enabled: false, updatedAt: this.now() }
        : entry,
    ),
  );
  return { task: original };
}

/**
 * O16+: restore original settings/history, carrying back only the cloud
 * version's instructions.
 */
export function restoreMigration(
  this: Scheduler,
  input: RoutineMigrationRestoreInput,
): Routine {
  const key = checkedMigrationKey(input?.key),
    id = checkedMigrationId(input?.id);
  const record = this.migrations.get(key);
  if (!record || record.kind !== "origin" || record.id !== id)
    throw new Error("This migration does not belong to this local task.");
  const current = this.schedules.find((entry) => entry.id === id) as
    MigrationStoredRoutine | undefined;
  if (!current) throw new Error("This scheduled task no longer exists.");
  if (record.state === "restored" || current.migrationRestoreKey === key)
    return structuredClone(this.listedTask(current));
  if (this.migrations.latestOrigin(id)?.key !== key)
    throw new Error("A newer move owns this scheduled task.");
  if (
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 100000
  )
    throw new Error(
      "Instructions are required and must be under 100000 characters.",
    );
  this.assertMigrationIdle(current);
  const restored: MigrationStoredRoutine = {
    ...record.task,
    prompt: input.prompt,
    updatedAt: this.now(),
    migrationRestoreKey: key,
  };
  this.commit(
    this.schedules.map((entry) => (entry.id === id ? restored : entry)),
  );
  // A crash before this journal update is recovered by the marker in the
  // same schedules commit. Later ordinary edits retain that marker.
  this.migrations.put({ ...record, state: "restored" });
  return structuredClone(this.listedTask(restored));
}

export function importMigration(
  this: Scheduler,
  input: RoutineMigrationImportInput,
  prepare?: (task: RoutineInput) => RoutineInput,
): Routine {
  const key = checkedMigrationKey(input?.key);
  const existing = this.schedules.find(
    (entry) => (entry as MigrationStoredRoutine).migrationImportKey === key,
  );
  if (this.migrations.get(key))
    throw new Error("This migration key was already used or deleted.");
  if (existing) return structuredClone(this.listedTask(existing));
  let fields: RoutineInput;
  const policy = this.options.policy?.();
  try {
    if (input.task?.id)
      throw new Error("An imported scheduled task must create a new task.");
    fields = validate(prepare ? prepare(input.task) : input.task);
    if (fields.id !== undefined)
      throw new Error("An imported scheduled task must create a new task.");
    const problem = routineNameProblem(fields.name, this.schedules);
    if (problem) throw new Error(problem);
    const limits = policy?.scheduledTasks;
    if (limits?.enabled === false) throw new Error(routinesOffMessage);
    if (
      typeof limits?.maxTasks === "number" &&
      this.schedules.length >= limits.maxTasks
    )
      throw new Error(routineLimitMessage(limits.maxTasks));
    if (this.schedules.length >= 1000)
      throw new Error("You can save up to 1,000 scheduled tasks.");
    if (
      (fields.permission ?? defaultRoutinePermission) === "auto" &&
      policy &&
      !modeAllowed(policy, "auto")
    )
      throw new Error(modeRefusal("auto"));
    if (
      fields.enabled &&
      fields.repeat?.kind === "once" &&
      fields.repeat.at <= this.now()
    )
      throw new Error(routineOncePastMessage);
  } catch (error) {
    throw migrationNotCreated(error);
  }
  // Every filesystem/commit uncertainty remains untagged: the caller must
  // retain the disabled origin and retry this exact key.
  return this.saveTask(fields, { migrationImportKey: key });
}

export function deleteMigration(
  this: Scheduler,
  input: RoutineMigrationDeleteInput,
): RoutineMigrationDeleteResult {
  const key = checkedMigrationKey(input?.key),
    id = checkedMigrationId(input?.id);
  const record = this.migrations.get(key);
  const current = this.schedules.find((entry) => entry.id === id) as
    MigrationStoredRoutine | undefined;
  if (record && (record.kind !== "deleted" || record.id !== id))
    throw new Error("This migration key belongs to a different task.");
  if (
    record?.kind === "deleted" &&
    record.completed &&
    !current &&
    !this.history[id]
  )
    return { deleted: true, historyDeleted: true };
  if (!record) {
    if (!current || current.migrationImportKey !== key)
      throw new Error("This task was not created by this migration.");
    this.assertMigrationIdle(current);
    this.migrations.put({ key, kind: "deleted", id });
  }
  if (current) {
    if (current.migrationImportKey !== key)
      throw new Error("This migration cannot delete a different task.");
    this.assertMigrationIdle(current);
    this.commit(this.schedules.filter((entry) => entry.id !== id));
  }
  const history = { ...this.history };
  delete history[id];
  // Unlike routine convenience history updates, a migration deletion must
  // fail if history deletion cannot be durably confirmed.
  const temporary = this.runsFilename + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(history), { mode: 0o600 });
    fs.renameSync(temporary, this.runsFilename);
    this.history = history;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
  try {
    coworkFolderGrants(this.root).forgetRoutine(id);
  } catch (error) {
    this.options.onError?.(error);
  }
  this.migrations.put({ key, kind: "deleted", id, completed: true });
  return { deleted: true, historyDeleted: true };
}
