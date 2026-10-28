import {
  validRoutineBrowserGrant,
  type RoutineBrowserGrant,
} from "../../shared/routine-browser";
import { routineEnvironmentKey } from "../../shared/routine-environment";
import type { Conversation } from "../../shared/types";
import {
  allowedKey,
  validAllowed,
  type Routine,
  type RoutineAllowed,
} from "../../shared/routines";
import type { Scheduler } from "./scheduler";
import { DAY } from "./scheduler-support";

/** Exact backend dispatch identity, never the renderer's task id alone. */
export function browserTask(
  this: Scheduler,
  conversation: Conversation,
): string | undefined {
  if (!conversation.scheduledRun || !conversation.scheduledTaskId) return;
  const id = conversation.scheduledTaskId;
  const task = this.schedules.find((value) => value.id === id);
  if (
    !task ||
    task.executionLocation === "remote" ||
    (task.environment !== undefined && task.environment.kind !== "local") ||
    (task.mode !== "code" && task.mode !== "cowork") ||
    this.migrationBlocked(id) ||
    conversation.mode !== task.mode ||
    (conversation.cwd ?? "") !== (task.cwd ?? "") ||
    routineEnvironmentKey(conversation.environment) !==
      routineEnvironmentKey(task.environment)
  )
    return;
  const turn = conversation.turns.at(-1);
  const dispatch = this.dispatch;
  if (
    dispatch?.taskId === id &&
    conversation.createdAt >= dispatch.since &&
    conversation.turns.length <= 1 &&
    (!turn || (turn.prompt === dispatch.prompt && turn.status === "inProgress"))
  )
    return id;
  if (
    this.unattendedIds.has(conversation.id) &&
    task.conversationId === conversation.id &&
    this.unattendedTurns.get(conversation.id) === turn?.id &&
    turn?.status === "inProgress"
  )
    return id;
}

export function browserGrant(
  this: Scheduler,
  id: string,
): RoutineBrowserGrant | undefined {
  const task = this.schedules.find((value) => value.id === id);
  return task?.browserGrant && structuredClone(task.browserGrant);
}

export function browserRevision(this: Scheduler, id: string): number {
  return (
    this.schedules.find((task) => task.id === id)?.browserGrantRevision ?? 0
  );
}

export function browserReadOnly(this: Scheduler, id: string): boolean {
  if (!this.schedules.some((value) => value.id === id))
    throw new Error("This scheduled task no longer exists.");
  return this.migrationBlocked(id);
}

/** Called only after the real Browser approval and safety/policy checks. */
export function allowBrowserSite(
  this: Scheduler,
  id: string,
  origin: string,
): void {
  this.assertMigrationUnlocked(id);
  const task = this.schedules.find((value) => value.id === id);
  if (!task) throw new Error("This scheduled task no longer exists.");
  if (this.options.policy?.().approvalsAlwaysAllow === false)
    throw new Error("Browser approvals are unavailable.");
  if (
    task.browserGrant?.mode === "all-websites" ||
    task.browserGrant?.domains.includes(origin)
  )
    return;
  const grant = validRoutineBrowserGrant({
    mode: "domains",
    domains: [...(task.browserGrant?.domains ?? []), origin],
    approvedAt: this.now(),
  })!;
  this.commit(
    this.schedules.map((value) =>
      value.id === id
        ? {
            ...value,
            browserGrant: grant,
            browserGrantRevision: (value.browserGrantRevision ?? 0) + 1,
            updatedAt: this.now(),
          }
        : value,
    ),
  );
}

export function clearBrowserGrant(this: Scheduler, id: string): void {
  this.assertMigrationUnlocked(id);
  if (!this.schedules.some((value) => value.id === id))
    throw new Error("This scheduled task no longer exists.");
  this.commit(
    this.schedules.map((value) =>
      value.id === id
        ? {
            ...value,
            browserGrant: undefined,
            browserGrantRevision: (value.browserGrantRevision ?? 0) + 1,
            updatedAt: this.now(),
          }
        : value,
    ),
  );
}

/** What a routine's runs may do without asking again (its "Always allowed" list). */
export function allowedFor(this: Scheduler, id: string): RoutineAllowed[] {
  const task = this.schedules.find((task) => task.id === id);
  return task ? this.listedAllowed(task).filter((entry) => !entry.expired) : [];
}

export function listedAllowed(
  this: Scheduler,
  task: Routine,
): RoutineAllowed[] {
  const days = this.options.policy?.().scheduledTasks.approvalLifetimeDays;
  return (task.alwaysAllowed ?? []).map((entry) => {
    const age = this.now() - (entry.approvedAt ?? task.createdAt);
    return {
      ...entry,
      ...(days !== undefined &&
      (days <= 0 || age < -300_000 || age >= days * DAY)
        ? { expired: true }
        : {}),
    };
  });
}

/** Dedicated removal. */
export function removeAllowed(
  this: Scheduler,
  id: string,
  entry: RoutineAllowed,
): boolean {
  const [valid] = validAllowed([entry]);
  const task = this.schedules.find((value) => value.id === id);
  if (!task) return false;
  const list = task.alwaysAllowed ?? [];
  const kept = list.filter(
    (item) =>
      item.tool !== valid.tool ||
      (valid.pattern !== undefined && item.pattern !== valid.pattern),
  );
  if (kept.length === list.length) return false;
  this.commit(
    this.schedules.map((value) =>
      value.id === id
        ? { ...value, alwaysAllowed: kept, updatedAt: this.now() }
        : value,
    ),
  );
  return true;
}

/**
 * Keeps an approval for a routine's later runs (the approval card's "Always
 * allow" during a run). Nothing happens for an unknown routine or an entry
 * already listed.
 */
export function allow(
  this: Scheduler,
  id: string,
  entry: RoutineAllowed,
): void {
  const task = this.schedules.find((value) => value.id === id);
  if (!task) return;
  const [valid] = validAllowed([entry]);
  const list = task.alwaysAllowed ?? [];
  if (
    this.allowedFor(id).some((item) => allowedKey(item) === allowedKey(valid))
  )
    return;
  this.commit(
    this.schedules.map((value) =>
      value.id === id
        ? {
            ...value,
            alwaysAllowed: [
              ...list.filter((item) => allowedKey(item) !== allowedKey(valid)),
              { ...valid, approvedAt: this.now() },
            ],
            updatedAt: this.now(),
          }
        : value,
    ),
  );
}
