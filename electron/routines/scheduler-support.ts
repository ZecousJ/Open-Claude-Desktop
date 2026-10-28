import {
  cleanRoutineTriggers,
  routineHasNoTrigger,
} from "../../shared/routine-triggers";
import { routineEnvironment } from "../../shared/routine-environment";
import path from "node:path";
import { createHash } from "node:crypto";
import { taskPermissions } from "../../shared/settings-extras";
import {
  frequencyFor,
  nextRun,
  validAllowed,
  validRepeat,
  type Routine,
  type RoutineInput,
} from "../../shared/routines";

export const routineMigrationLockedMessage =
  "This task is moving between this computer and the cloud. Finish that move before changing or running it.";

export function migrationNotCreated(error: unknown): Error & { code: string } {
  return Object.assign(
    error instanceof Error ? error : new Error(String(error)),
    { code: "CLAUDEX_MIGRATION_NOT_CREATED" },
  );
}

const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/**
 * The next slot after `now`, skipping missed ones. A routine follows its
 * rule (a manual one keeps its time: it never starts by itself); a task
 * saved before routines keeps its anchor's local time.
 */
export function nextOccurrence(
  schedule: Pick<Routine, "frequency" | "nextRunAt" | "repeat">,
  now: number,
): number {
  if (schedule.repeat)
    return nextRun(schedule.repeat, now) ?? schedule.nextRunAt;
  const anchor = schedule.nextRunAt;
  if (anchor > now) return anchor;
  if (schedule.frequency === "hourly")
    return anchor + (Math.floor((now - anchor) / HOUR) + 1) * HOUR;
  const days = schedule.frequency === "weekly" ? 7 : 1;
  const date = new Date(anchor);
  date.setDate(
    date.getDate() +
      Math.max(1, Math.floor((now - anchor) / (days * DAY))) * days,
  );
  while (date.getTime() <= now) date.setDate(date.getDate() + days);
  return date.getTime();
}

export function validate(input: RoutineInput): RoutineInput {
  if (!input || typeof input !== "object")
    throw new Error("Invalid scheduled task.");
  if (
    input.executionLocation !== undefined &&
    input.executionLocation !== "local" &&
    input.executionLocation !== "remote"
  )
    throw new Error("Invalid scheduled task.");
  if (
    input.disableJitter !== undefined &&
    typeof input.disableJitter !== "boolean"
  )
    throw new Error("Invalid scheduled task.");
  const notify = input.notifyOnCompletion;
  if (
    notify !== undefined &&
    (!notify ||
      typeof notify !== "object" ||
      [notify.push, notify.email, notify.slack].some(
        (value) => typeof value !== "boolean",
      ))
  )
    throw new Error("Invalid scheduled task.");
  const string = (value: unknown, label: string, limit: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit)
      throw new Error(
        `${label} is required and must be under ${limit} characters.`,
      );
    return value.trim();
  };
  if (input.id !== undefined && (typeof input.id !== "string" || !input.id))
    throw new Error("Invalid task ID.");
  if (!["code", "cowork"].includes(input.mode))
    throw new Error("Choose Code or Cowork.");
  const repeat =
    input.repeat === undefined ? undefined : validRepeat(input.repeat);
  if (!repeat && !["hourly", "daily", "weekly"].includes(input.frequency))
    throw new Error("Choose an hourly, daily or weekly schedule.");
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 1000)
  )
    throw new Error("Description must be under 1000 characters.");
  if (
    input.defaultModel !== undefined &&
    typeof input.defaultModel !== "boolean"
  )
    throw new Error("Invalid model choice.");
  if (
    input.securityReview !== undefined &&
    typeof input.securityReview !== "boolean"
  )
    throw new Error("Invalid security review setting.");
  if (input.securityReview && !input.cwd)
    throw new Error("Choose the folder to review.");
  if (
    input.permission !== undefined &&
    !taskPermissions.includes(input.permission)
  )
    throw new Error("Choose a permission mode.");
  const alwaysAllowed =
    input.alwaysAllowed === undefined
      ? undefined
      : validAllowed(input.alwaysAllowed);
  if (
    typeof input.nextRunAt !== "number" ||
    !Number.isFinite(input.nextRunAt) ||
    !Number.isFinite(new Date(input.nextRunAt).getTime())
  )
    throw new Error("Choose a valid next run time.");
  if (typeof input.enabled !== "boolean")
    throw new Error("Invalid task enabled state.");
  if (
    input.cwd !== undefined &&
    (typeof input.cwd !== "string" ||
      (input.cwd && !path.isAbsolute(input.cwd)))
  )
    throw new Error("Choose an absolute workspace folder.");
  if (
    input.projectId !== undefined &&
    (typeof input.projectId !== "string" || input.projectId.length > 200)
  )
    throw new Error("Invalid project.");
  const triggers =
    input.triggers === undefined
      ? undefined
      : cleanRoutineTriggers(input.triggers);
  if (input.triggers !== undefined && !triggers)
    throw new Error("Invalid scheduled task.");
  if (routineHasNoTrigger(triggers)) throw new Error("Select a trigger.");
  const repository = input.repository;
  if (
    repository !== undefined &&
    (!repository ||
      typeof repository !== "object" ||
      typeof repository.url !== "string" ||
      !/^https:\/\/[^\s]{1,500}$/.test(repository.url) ||
      (repository.ref !== undefined &&
        (typeof repository.ref !== "string" || repository.ref.length > 250)))
  )
    throw new Error("Choose a repository.");
  if (
    input.cloudEnvironmentId !== undefined &&
    (typeof input.cloudEnvironmentId !== "string" ||
      !/^[\w-]{1,200}$/.test(input.cloudEnvironmentId))
  )
    throw new Error("Select a cloud environment.");
  return {
    ...(input.id ? { id: input.id } : {}),
    ...(triggers ? { triggers } : {}),
    ...(repository
      ? {
          repository: {
            url: repository.url,
            ...(repository.ref ? { ref: repository.ref } : {}),
          },
        }
      : {}),
    ...(input.cloudEnvironmentId
      ? { cloudEnvironmentId: input.cloudEnvironmentId }
      : {}),
    ...(input.autoFixPullRequests === true && input.mode === "code"
      ? { autoFixPullRequests: true }
      : {}),
    name: string(input.name, "Name", 120),
    prompt: string(input.prompt, "Instructions", 100_000),
    mode: input.mode,
    cwd: input.cwd || undefined,
    ...(input.environment !== undefined
      ? { environment: routineEnvironment(input.environment) }
      : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    providerId: string(input.providerId, "Connection", 200),
    model: string(input.model, "Model", 200),
    frequency: repeat ? frequencyFor(repeat) : input.frequency,
    nextRunAt: input.nextRunAt,
    enabled: input.enabled,
    ...(input.executionLocation
      ? { executionLocation: input.executionLocation }
      : {}),
    ...(input.disableJitter !== undefined
      ? { disableJitter: input.disableJitter }
      : {}),
    ...(notify
      ? {
          notifyOnCompletion: {
            push: notify.push,
            email: notify.email,
            slack: notify.slack,
          },
        }
      : {}),
    ...(input.description !== undefined
      ? { description: input.description.trim() }
      : {}),
    ...(repeat ? { repeat } : {}),
    ...(input.defaultModel ? { defaultModel: true } : {}),
    ...(input.securityReview ? { securityReview: true } : {}),
    ...(input.permission ? { permission: input.permission } : {}),
    ...(alwaysAllowed ? { alwaysAllowed } : {}),
  };
}

/** Said when a one-time routine is saved on, or switched on at, a moment that has passed. */
export const routineOncePastMessage = "Choose a time in the future.";

/** Deterministic dispatch delay. */
export function routineJitterSeconds(task: Routine, now: number): number {
  if (
    task.disableJitter !== false ||
    !task.repeat ||
    task.repeat.kind === "manual" ||
    task.repeat.kind === "once"
  )
    return 0;
  const first = nextRun(task.repeat, now);
  const second = first === undefined ? undefined : nextRun(task.repeat, first);
  const interval =
    first === undefined || second === undefined
      ? 10
      : (second - first) / 60_000;
  const cap = Math.min(10, interval - 1) * 60;
  return cap <= 0
    ? 0
    : createHash("sha256").update(task.id).digest().readUInt32BE(0) % cap;
}
