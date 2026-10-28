import fs from "node:fs";
import {
  taskConnectionHoldMessage,
  type TaskConnectionHold,
} from "../../shared/task-connection-hold";
import { randomUUID } from "node:crypto";
import type { Conversation } from "../../shared/types";
import {
  routineDispatchAt,
  routinesOffMessage,
  scheduleOff,
  type Routine,
} from "../../shared/routines";
import { routineRunLimit, type RoutineRun } from "../../shared/routine-labels";
import {
  routineGitHubMatches,
  type RoutineEventFields,
} from "../../shared/routine-triggers";
import {
  coworkFolderGrants,
  routineFolderPermissionMessage,
} from "../workspace/cowork-folders";
import type { Scheduler } from "./scheduler";
import { nextOccurrence } from "./scheduler-support";

export async function tick(this: Scheduler): Promise<void> {
  const now = this.now();
  const slept = now - this.lastTickAt > 60_000;
  this.lastTickAt = now;
  if (!this.allowed()) return;
  for (const task of this.schedules.slice()) {
    if (
      this.migrationBlocked(task.id) ||
      !task.enabled ||
      scheduleOff(task) ||
      routineDispatchAt(task) > now
    )
      continue;
    if (task.lastRunStatus === "starting" || task.lastRunStatus === "running")
      this.skip(task, "in_progress");
    else if (task.connectionHold) this.skip(task, "sign_in");
    else if (slept && routineDispatchAt(task) < now - 60_000)
      this.skip(task, "missed");
    else if (this.executing || this.options.isBusy()) this.skip(task, "busy");
  }
  if (this.executing || this.options.isBusy()) return;
  const due = this.schedules
    .filter(
      (task) =>
        task.enabled &&
        !this.migrationBlocked(task.id) &&
        !task.connectionHold &&
        (task.mode !== "cowork" || this.options.computerAccess?.() !== false) &&
        !scheduleOff(task) &&
        routineDispatchAt(task) <= now,
    )
    .sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt)[0];
  if (due) await this.execute(due.id, "schedule");
}

export function skip(
  this: Scheduler,
  task: Routine,
  reason: NonNullable<RoutineRun["skipReason"]>,
): void {
  const now = this.now();
  const run: RoutineRun = {
    id: randomUUID(),
    startedAt: task.nextRunAt,
    status: "skipped",
    trigger: "schedule",
    skipReason: reason,
  };
  this.history[task.id] = [run, ...(this.history[task.id] ?? [])].slice(
    0,
    routineRunLimit,
  );
  this.saveHistory();
  this.commit(
    this.schedules.map((value) =>
      value.id === task.id
        ? {
            ...value,
            nextRunAt: nextOccurrence(value, now),
            ...(value.repeat?.kind === "once" ? { enabled: false } : {}),
            updatedAt: now,
          }
        : value,
    ),
  );
}

export async function runNow(this: Scheduler, id: string): Promise<Routine> {
  if (!this.allowed()) throw new Error(routinesOffMessage);
  return this.execute(id, "manual");
}

/**
 * Starts the task its API or GitHub trigger names: the service checked the
 * caller's token or the event's signature. `extra` (the call's text, or what
 * the event was) follows the instructions.
 */
export async function fireTrigger(
  this: Scheduler,
  triggerId: string,
  kind: "api" | "github",
  extra?: string,
  /** A GitHub event: it runs the task only when its trigger watches it and
   * every filter holds. */
  event?: { name: string; fields: RoutineEventFields },
): Promise<Routine | undefined> {
  if (!this.allowed()) throw new Error(routinesOffMessage);
  const task = this.schedules.find(
    (value) => value.triggers?.[kind]?.id === triggerId,
  );
  if (!task) throw new Error("This trigger no longer exists.");
  if (!task.enabled) throw new Error("This scheduled task is paused.");
  const github = task.triggers?.github;
  if (
    kind === "github" &&
    (!github ||
      !event ||
      !routineGitHubMatches(github, event.name, event.fields))
  )
    return undefined;
  return this.execute(task.id, kind, extra);
}

/** Records the API token's hint the service gave (or its removal). */
export function setApiTokenHint(
  this: Scheduler,
  triggerId: string,
  hint: string | undefined,
): Routine {
  const task = this.schedules.find(
    (value) => value.triggers?.api?.id === triggerId,
  );
  if (!task?.triggers?.api) throw new Error("This trigger no longer exists.");
  const api = { id: triggerId, ...(hint ? { tokenHint: hint } : {}) };
  const next = {
    ...task,
    triggers: { ...task.triggers, api },
    updatedAt: this.now(),
  };
  this.commit(
    this.schedules.map((value) => (value.id === task.id ? next : value)),
  );
  return structuredClone(this.listedTask(next));
}

export function holdForConnection(
  this: Scheduler,
  id: string,
  connectionHold: TaskConnectionHold,
): void {
  this.commit(
    this.schedules.map((task) =>
      task.id === id
        ? {
            ...task,
            connectionHold,
            lastError: taskConnectionHoldMessage,
            updatedAt: this.now(),
          }
        : task,
    ),
  );
}

/**
 * Routines on the default model follow the active connection's default;
 * called after Settings change. Returns whether anything changed.
 */
export function retargetDefaults(
  this: Scheduler,
  providerId: string,
  model: string,
): boolean {
  if (!providerId || !model) return false;
  const changed = this.schedules.some(
    (task) =>
      task.defaultModel &&
      (task.providerId !== providerId || task.model !== model),
  );
  if (changed)
    this.commit(
      this.schedules.map((task) =>
        task.defaultModel ? { ...task, providerId, model } : task,
      ),
    );
  return changed;
}

export async function execute(
  this: Scheduler,
  id: string,
  trigger: RoutineRun["trigger"],
  /** Text that follows the instructions in this run only. */
  extra?: string,
): Promise<Routine> {
  this.assertMigrationUnlocked(id);
  if (this.executing || this.options.isBusy())
    throw new Error("Another task is running. Try again when it finishes.");
  const task = this.schedules.find((value) => value.id === id);
  if (!task) throw new Error("This scheduled task no longer exists.");
  if (task.mode === "cowork" && this.options.computerAccess?.() === false)
    throw new Error(
      "This task will run on schedule once Computer access is on.",
    );
  this.executing = true;
  const now = this.now();
  const run: RoutineRun = {
    id: randomUUID(),
    startedAt: now,
    status: "starting",
    trigger,
  };
  this.history[id] = [run, ...(this.history[id] ?? [])].slice(
    0,
    routineRunLimit,
  );
  this.saveHistory();
  const prompt = extra?.trim()
    ? `${task.prompt}\n\n${extra.trim()}`
    : task.prompt;
  this.dispatch = { taskId: id, prompt, since: now };
  // A one-time routine switches itself off once its moment has come,
  // however it was started, so it cannot run a second time.
  const fires = task.repeat?.kind === "once" && now >= task.repeat.at;
  const reserved: Routine = {
    ...task,
    connectionHold: undefined,
    ...(fires ? { enabled: false } : {}),
    nextRunAt: nextOccurrence(task, now),
    lastRunAt: now,
    lastRunStatus: "starting",
    lastError: undefined,
    lastRunSummary: undefined,
    lastRunNotify: undefined,
    conversationId: undefined,
    updatedAt: now,
  };
  try {
    // Reserve and persist the slot before dispatching. A crash must never replay this occurrence.
    this.commit(
      this.schedules.map((value) => (value.id === id ? reserved : value)),
    );
    // Nobody is there to answer the folder question: an unattended Cowork
    // run uses only a trusted folder or one allowed for this routine (R11).
    const grants =
      reserved.mode === "cowork" ? coworkFolderGrants(this.root) : undefined;
    if (grants && !grants.routineAllowed(reserved.id, reserved.cwd))
      throw new Error(routineFolderPermissionMessage);
    const conversation = await this.options.run(
      structuredClone({ ...reserved, prompt }),
    );
    // Follow-ups the person writes in the run's conversation use the same folder.
    // The run already started: failing to record this never fails the run.
    if (grants && reserved.cwd)
      try {
        grants.bind(conversation, reserved.cwd, { consumeAllow: false });
      } catch (error) {
        this.options.onError?.(error);
      }
    this.markUnattended(
      this.recentConversations.get(conversation.id) ?? conversation,
    );
    this.activeRuns.set(id, run.id);
    this.updateRun(id, run.id, {
      status: "running",
      conversationId: conversation.id,
    });
    const current = this.schedules.find((value) => value.id === id);
    if (current) {
      this.commit(
        this.schedules.map((value) =>
          value.id === id
            ? {
                ...value,
                conversationId: conversation.id,
                lastRunStatus: "running",
                updatedAt: this.now(),
              }
            : value,
        ),
      );
      this.observeConversation(
        this.recentConversations.get(conversation.id) ?? conversation,
      );
    }
    return structuredClone(
      this.schedules.find((value) => value.id === id) ?? {
        ...reserved,
        conversationId: conversation.id,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let repositoryUnavailable = false;
    if (
      reserved.mode === "code" &&
      reserved.cwd &&
      (!reserved.environment || reserved.environment.kind === "local")
    ) {
      try {
        fs.accessSync(reserved.cwd, fs.constants.R_OK | fs.constants.X_OK);
        repositoryUnavailable = !fs.statSync(reserved.cwd).isDirectory();
      } catch (accessError) {
        repositoryUnavailable = [
          "ENOENT",
          "EACCES",
          "EPERM",
          "ENOTDIR",
        ].includes((accessError as NodeJS.ErrnoException).code ?? "");
      }
    }
    this.activeRuns.delete(id);
    this.updateRun(id, run.id, {
      status: "failed",
      error: message,
      finishedAt: this.now(),
    });
    if (this.schedules.some((value) => value.id === id))
      this.commit(
        this.schedules.map((value) =>
          value.id === id
            ? {
                ...value,
                ...(repositoryUnavailable
                  ? {
                      enabled: false,
                      endedReason: "auto_disabled_repo_access" as const,
                    }
                  : {}),
                lastRunStatus: "failed",
                lastError: message,
                updatedAt: this.now(),
              }
            : value,
        ),
      );
    throw error;
  } finally {
    this.executing = false;
    this.dispatch = undefined;
    this.recentConversations.clear();
  }
}

/** Marks the conversation a routine just started, until its turn ends. */
export function markUnattended(this: Scheduler, conversation: Conversation) {
  const turn = conversation.turns.at(-1);
  if (!turn || turn.status !== "inProgress") return;
  const added = !this.unattendedIds.has(conversation.id);
  this.unattendedIds.add(conversation.id);
  this.unattendedTurns.set(conversation.id, turn.id);
  if (added) this.unattendedChanged(conversation.id, true);
}

/**
 * Follows an unattended conversation: the run's turn finishing or a newer
 * turn (the person writing in it) ends the unattended state.
 */
export function followUnattended(this: Scheduler, conversation: Conversation) {
  const dispatch = this.dispatch;
  const first = conversation.turns[0];
  // The run's conversation can report its first turn before `run` returns.
  if (
    dispatch &&
    !this.unattendedIds.has(conversation.id) &&
    conversation.turns.length === 1 &&
    first?.prompt === dispatch.prompt &&
    conversation.createdAt >= dispatch.since
  )
    this.markUnattended(conversation);
  const turnId = this.unattendedTurns.get(conversation.id);
  if (turnId === undefined) return;
  const last = conversation.turns.at(-1);
  // The engine names a new turn "pending-…" until Codex gives it its id:
  // the run's turn getting its real id is still the run.
  if (
    last &&
    last.id !== turnId &&
    turnId.startsWith("pending-") &&
    !last.id.startsWith("pending-") &&
    last.status === "inProgress" &&
    conversation.turns.length === 1
  )
    this.unattendedTurns.set(conversation.id, last.id);
  else if (!last || last.id !== turnId || last.status !== "inProgress") {
    this.unattendedIds.delete(conversation.id);
    this.unattendedTurns.delete(conversation.id);
    this.unattendedChanged(conversation.id, false);
  }
}

export function observeConversation(
  this: Scheduler,
  conversation: Conversation,
  notification?: { summary: string | null },
): void {
  if (this.executing) {
    this.recentConversations.set(
      conversation.id,
      structuredClone(conversation),
    );
    if (this.recentConversations.size > 10)
      this.recentConversations.delete(
        this.recentConversations.keys().next().value!,
      );
  }
  this.followUnattended(conversation);
  const turn = conversation.turns.at(-1);
  if (!turn) return;
  const task = this.schedules.find(
    (value) =>
      value.conversationId === conversation.id &&
      ["starting", "running"].includes(value.lastRunStatus ?? ""),
  );
  if (!task) return;
  const status = turn.status === "inProgress" ? "running" : turn.status;
  if (
    status === "completed" &&
    this.options.summarize &&
    !notification &&
    (!task.notifyOnCompletion ||
      Object.values(task.notifyOnCompletion).some(Boolean))
  ) {
    if (this.summarizing.has(conversation.id)) return;
    this.summarizing.add(conversation.id);
    const pending = this.options
      .summarize(task, conversation)
      .then((summary) => {
        this.observeConversation(conversation, { summary });
      })
      .catch((error) => {
        this.options.onError?.(error);
        this.observeConversation(conversation, {
          summary: turn.items
            .filter((item) => item.type === "agentMessage")
            .map((item) => item.text ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240),
        });
      })
      .finally(() => {
        this.summarizing.delete(conversation.id);
        this.summaries.delete(pending);
      });
    this.summaries.add(pending);
    return;
  }
  const error =
    turn.error ||
    (status === "interrupted"
      ? "This run was interrupted. Open its conversation to continue."
      : undefined);
  if (task.lastRunStatus === status && task.lastError === error) return;
  const summary =
    status === "completed"
      ? notification
        ? (notification.summary ?? undefined)
        : turn.items
            .filter((item) => item.type === "agentMessage")
            .map((item) => item.text ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240) || undefined
      : undefined;
  if (status !== "running" && task.lastRunStatus !== status)
    try {
      this.options.onRunEnded?.(structuredClone(task), {
        outcome: status === "completed" ? "completed" : "failed",
        ...(summary ? { summary } : {}),
        ...(error ? { error } : {}),
      });
    } catch (reason) {
      this.options.onError?.(reason);
    }
  const runId = this.activeRuns.get(task.id);
  if (runId) {
    const done = status !== "running";
    this.updateRun(task.id, runId, {
      status,
      error,
      finishedAt: done ? this.now() : undefined,
    });
    if (done) this.activeRuns.delete(task.id);
  }
  this.commit(
    this.schedules.map((value) =>
      value.id === task.id
        ? {
            ...value,
            lastRunStatus: status,
            lastError: error,
            lastRunSummary: summary,
            lastRunNotify: notification?.summary !== null,
            updatedAt: this.now(),
          }
        : value,
    ),
  );
}
