import { validRoutineBrowserGrant } from "../../shared/routine-browser";
import fs from "node:fs";
import path from "node:path";
import type { Conversation, Schedule } from "../../shared/types";
import { type ClientPolicy } from "../../shared/client-policy";
import {
  nextRun,
  routineDispatchAt,
  scheduleOff,
  validRepeat,
  type Routine,
  type RoutineInput,
  type RoutineRunQuery,
  type RoutineRunPage,
  type RoutineSchedulePreview,
} from "../../shared/routines";
import {
  routineRunLimit,
  routineRunTriggers,
  type RoutineRun,
} from "../../shared/routine-labels";
import { pageRoutineRuns } from "../../shared/routine-history-page";
import { recordedRoutineRunCount } from "../../shared/routine-run-count";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import {
  RoutineMigrationJournal,
  migrationKeyPattern,
  type MigrationStoredRoutine,
} from "./routine-migration-journal";
import * as schedulerTasks from "./scheduler-tasks";
import { installMethods } from "./install-methods";
import * as schedulerMigration from "./scheduler-migration";
import * as schedulerBrowser from "./scheduler-browser";
import * as schedulerRuns from "./scheduler-runs";
import { routineMigrationLockedMessage, validate } from "./scheduler-support";

const runStatuses = new Set<RoutineRun["status"]>([
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "skipped",
]);

/** Keeps the runs of a history file that make sense; drops the rest. */
function validRuns(value: unknown): Record<string, RoutineRun[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, RoutineRun[]> = {};
  for (const [id, runs] of Object.entries(value)) {
    if (!Array.isArray(runs)) continue;
    const kept = runs
      .filter(
        (run): run is RoutineRun =>
          !!run &&
          typeof run.id === "string" &&
          Number.isFinite(run.startedAt) &&
          runStatuses.has(run.status) &&
          routineRunTriggers.includes(run.trigger) &&
          (run.finishedAt === undefined || Number.isFinite(run.finishedAt)) &&
          (run.error === undefined || typeof run.error === "string") &&
          (run.readAt === undefined || Number.isFinite(run.readAt)) &&
          (run.skipReason === undefined ||
            ["missed", "in_progress", "busy", "sign_in"].includes(
              run.skipReason,
            )) &&
          (run.conversationId === undefined ||
            typeof run.conversationId === "string"),
      )
      .slice(0, routineRunLimit);
    if (kept.length) result[id] = kept;
  }
  return result;
}
interface SchedulerOptions {
  summarize?: (
    task: Routine,
    conversation: Conversation,
  ) => Promise<string | null>;
  onFinish?: (task: Routine) => Promise<void>;
  /**
   * A run ended: finished, failed or was interrupted (the task's e-mail,
   * electron/routine-mail.ts). Called once per run.
   */
  onRunEnded?: (
    task: Routine,
    run: { outcome: "completed" | "failed"; summary?: string; error?: string },
  ) => void;
  computerAccess?: () => boolean;
  isBusy: () => boolean;
  run: (schedule: Routine) => Promise<Conversation>;
  onChange?: (schedules: Schedule[]) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
  /**
   * The administrator's policy now. With `scheduledTasks.enabled` false no
   * routine starts (saved ones wait, unchanged) and none can be added;
   * `maxTasks` caps how many can be added. Which permission mode a run uses
   * is not the policy's business: runs follow the person's Code setting.
   */
  policy?: () => ClientPolicy;
}

export class Scheduler {
  schedules: Routine[] = [];
  readonly migrations: RoutineMigrationJournal;
  private timer?: NodeJS.Timeout;
  executing = false;
  recentConversations = new Map<string, Conversation>();
  private readonly filename: string;
  readonly runsFilename: string;
  history: Record<string, RoutineRun[]> = {};
  /** The run being dispatched: its routine, its prompt and when it started. */
  dispatch?: { taskId: string; prompt: string; since: number };
  /** Conversations a routine started whose run has not been seen to end. */
  unattendedIds = new Set<string>();
  readonly now: () => number;
  lastTickAt: number;
  constructor(
    readonly root: string,
    public options: SchedulerOptions,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.migrations = new RoutineMigrationJournal(root, validate);
    this.filename = path.join(root, "schedules.json");
    this.runsFilename = path.join(root, "routine-runs.json");
    // Cowork folder grants adopt the routines saved before they existed, and
    // only those: read them before this session can save a new routine (R11).
    try {
      coworkFolderGrants(root).ensureLoaded();
    } catch (error) {
      options.onError?.(error);
    }
    this.now = options.now ?? Date.now;
    this.lastTickAt = this.now();
    try {
      this.history = validRuns(
        JSON.parse(fs.readFileSync(this.runsFilename, "utf8")),
      );
    } catch {
      // Run history is a convenience; an unreadable file starts it afresh.
      this.history = {};
    }
    // Runs cut off by the app closing did not finish.
    for (const runs of Object.values(this.history))
      for (const run of runs)
        if (run.status === "starting" || run.status === "running") {
          run.status = "interrupted";
          run.error ??=
            "The app closed while this run was active. Open its conversation to continue.";
        }
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.filename, "utf8"));
      if (!Array.isArray(data) || data.length > 1000)
        throw new Error("Invalid task list.");
      const ids = new Set<string>();
      for (const value of data) {
        const fields = validate(value);
        if (
          !fields.id ||
          ids.has(fields.id) ||
          !Number.isFinite(value.createdAt) ||
          !Number.isFinite(value.updatedAt)
        )
          throw new Error("Invalid saved task.");
        for (const key of [value.migrationImportKey, value.migrationRestoreKey])
          if (
            key !== undefined &&
            (typeof key !== "string" || !migrationKeyPattern.test(key))
          )
            throw new Error("Invalid saved migration metadata.");
        const browserGrant = validRoutineBrowserGrant(value.browserGrant);
        if (
          value.browserGrantRevision !== undefined &&
          (!Number.isSafeInteger(value.browserGrantRevision) ||
            value.browserGrantRevision < 0)
        )
          throw new Error("Invalid saved Browser revision.");
        ids.add(fields.id);
        this.schedules.push({
          ...value,
          ...fields,
          ...(browserGrant ? { browserGrant } : {}),
          id: fields.id,
        });
      }
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new Error(
          "schedules.json could not be read. Your saved tasks have not been overwritten.",
        );
    }
    const recovered = this.schedules.map((task) =>
      ["starting", "running"].includes(task.lastRunStatus ?? "")
        ? {
            ...task,
            lastRunStatus: "interrupted" as const,
            lastError:
              "The app closed while this run was active. Open its conversation to continue.",
            updatedAt: this.now(),
          }
        : task,
    );
    if (recovered.some((task, index) => task !== this.schedules[index]))
      this.commit(recovered);
    for (const task of this.schedules.slice())
      if (
        !this.migrationBlocked(task.id) &&
        task.enabled &&
        !scheduleOff(task) &&
        routineDispatchAt(task) < this.now()
      )
        this.skip(task, "missed");
  }
  list(): Routine[] {
    return structuredClone(this.schedules.map((task) => this.listedTask(task)));
  }
  listedTask(task: Routine): Routine {
    const {
      runCount: _count,
      runCountLimited: _limited,
      migrationImportKey: _importKey,
      migrationRestoreKey: _restoreKey,
      ...fields
    } = task as MigrationStoredRoutine;
    return {
      ...fields,
      ...(this.migrationBlocked(task.id) ? { enabled: false } : {}),
      ...recordedRoutineRunCount(this.history[task.id] ?? [], task.lastRunAt),
      ...(task.alwaysAllowed
        ? { alwaysAllowed: this.listedAllowed(task) }
        : {}),
    };
  }
  /** A routine's runs, newest first. */
  runs(id: string): RoutineRun[] {
    if (!this.schedules.some((task) => task.id === id))
      throw new Error("This scheduled task no longer exists.");
    return structuredClone(this.history[id] ?? []);
  }
  runsPage(id: string, query?: RoutineRunQuery): RoutineRunPage {
    return pageRoutineRuns(id, this.runs(id), query);
  }
  preview(repeat: unknown): RoutineSchedulePreview {
    const rule = validRepeat(repeat);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      nextRunAt: nextRun(rule, this.now()) ?? null,
      ...(timeZone ? { timeZone } : {}),
    };
  }
  markRunRead(id: string, runId: string): void {
    if (
      !this.history[id]?.some(
        (run) => run.id === runId && run.status === "completed",
      )
    )
      return;
    this.updateRun(id, runId, { readAt: this.now() });
    this.options.onChange?.(this.list());
  }
  markConversationRead(conversationId: string): void {
    let changed = false;
    for (const runs of Object.values(this.history))
      for (const run of runs)
        if (
          run.conversationId === conversationId &&
          run.status === "completed" &&
          !run.readAt
        ) {
          run.readAt = this.now();
          changed = true;
        }
    if (changed) {
      this.saveHistory();
      this.options.onChange?.(this.list());
    }
  }
  /**
   * True while a routine's run is working in this conversation: started by
   * the scheduler (on its rule or with Run now) and not yet finished. Tools
   * that need someone at the computer (a dev server's Browser panel, for
   * example) refuse unattended runs. A turn the person sends afterwards in
   * the same conversation is attended again.
   */
  isUnattended(conversationId: string): boolean {
    return this.unattendedIds.has(conversationId);
  }
  /**
   * `isUnattended`, and also true for the conversation a routine is creating
   * right now: while a run is being dispatched, a conversation created since
   * then that has no turn yet (or only the run's prompt) is the run's. The
   * engine asks this while it prepares the run's thread, before `run`
   * returns, so tools that need someone at the computer (computer use) are
   * never offered to the run. At worst a chat the person starts in the same
   * instant is treated as unattended for its first message.
   */
  isUnattendedConversation(
    conversation: Pick<Conversation, "id" | "createdAt" | "turns">,
  ): boolean {
    if (this.unattendedIds.has(conversation.id)) return true;
    const dispatch = this.dispatch;
    if (!dispatch || conversation.createdAt < dispatch.since) return false;
    const turns = conversation.turns;
    return (
      turns.length === 0 ||
      (turns.length === 1 && turns[0]?.prompt === dispatch.prompt)
    );
  }
  /**
   * The routine whose run is working in this conversation right now (it is
   * unattended, `isUnattendedConversation`), so a request for approval or an
   * answer there can say which scheduled task waits. Undefined for any other
   * conversation, and once the person writes in it.
   */
  runningTask(
    conversation: Pick<Conversation, "id" | "createdAt" | "turns">,
  ): Routine | undefined {
    if (!this.isUnattendedConversation(conversation)) return;
    const task =
      this.schedules.find(
        (value) => value.conversationId === conversation.id,
      ) ??
      (this.dispatch &&
        this.schedules.find((value) => value.id === this.dispatch?.taskId));
    return task && structuredClone(task);
  }
  private unattendedListeners = new Set<
    (conversationId: string, unattended: boolean) => void
  >();
  /**
   * Runs `cb` when a conversation becomes unattended (a routine's run
   * started in it) or attended again (the run's turn ended, or the person
   * wrote in it). Returns the unsubscribe.
   */
  onUnattendedChange(
    cb: (conversationId: string, unattended: boolean) => void,
  ): () => void {
    this.unattendedListeners.add(cb);
    return () => this.unattendedListeners.delete(cb);
  }
  unattendedChanged(conversationId: string, unattended: boolean) {
    for (const cb of this.unattendedListeners)
      try {
        cb(conversationId, unattended);
      } catch (error) {
        this.options.onError?.(error);
      }
  }
  saveHistory() {
    const temporary = this.runsFilename + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.history), {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.runsFilename);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
  updateRun(taskId: string, runId: string, patch: Partial<RoutineRun>) {
    const run = this.history[taskId]?.find((value) => value.id === runId);
    if (!run) return;
    Object.assign(run, patch);
    for (const key of Object.keys(patch) as (keyof RoutineRun)[])
      if (patch[key] === undefined) delete run[key];
    this.saveHistory();
  }
  /** False while the administrator has turned routines off. */
  allowed() {
    return this.options.policy?.().scheduledTasks.enabled !== false;
  }
  commit(tasks: Routine[]) {
    const previous = this.schedules;
    const temporary = this.filename + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(tasks, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filename);
    this.schedules = tasks;
    for (const task of tasks) {
      const before = previous.find((value) => value.id === task.id);
      if (
        before &&
        ["starting", "running"].includes(before.lastRunStatus ?? "") &&
        ["completed", "failed", "interrupted"].includes(
          task.lastRunStatus ?? "",
        )
      )
        this.finish(task);
    }
    try {
      this.options.onChange?.(this.list());
    } catch (error) {
      this.options.onError?.(error);
    }
  }
  private deliveries = new Set<Promise<void>>();
  get pendingWork() {
    return this.summarizing.size > 0 || this.deliveries.size > 0;
  }
  async settle() {
    while (this.pendingWork) {
      await Promise.allSettled([...this.summaries, ...this.deliveries]);
    }
  }
  private finish(task: Routine) {
    if (!this.options.onFinish) return;
    const pending = Promise.resolve()
      .then(() => this.options.onFinish!(structuredClone(task)))
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.deliveries.delete(pending));
    this.deliveries.add(pending);
  }
  save(input: RoutineInput, origin?: { setupConversationId: string }): Routine {
    if (
      origin &&
      (typeof origin.setupConversationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(origin.setupConversationId) ||
        input.id)
    )
      throw new Error("Invalid scheduled task setup origin.");
    // The ordinary save boundary projects only the trusted setup origin;
    // callers cannot smuggle private import/restore metadata through it.
    return this.saveTask(
      input,
      origin ? { setupConversationId: origin.setupConversationId } : undefined,
    );
  }
  delete(id: string): void {
    const imported = this.schedules.find((task) => task.id === id) as
      MigrationStoredRoutine | undefined;
    const origin = this.migrations.latestOrigin(id);
    if (
      origin?.state === "locked" &&
      imported?.migrationRestoreKey !== origin.key
    )
      throw new Error(routineMigrationLockedMessage);
    const importKey =
      imported?.migrationImportKey ?? this.migrations.deletion(id)?.key;
    if (importKey) {
      // Ordinary deletion also preserves idempotency, including a user's
      // retry after task deletion succeeded but history cleanup failed.
      this.deleteMigration({ key: importKey, id });
      return;
    }
    this.assertMigrationUnlocked(id);
    if (!this.schedules.some((task) => task.id === id))
      throw new Error("This scheduled task no longer exists.");
    this.commit(this.schedules.filter((task) => task.id !== id));
    try {
      coworkFolderGrants(this.root).forgetRoutine(id);
    } catch (error) {
      this.options.onError?.(error);
    }
    if (this.history[id]) {
      delete this.history[id];
      this.saveHistory();
    }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.options.onError?.(error));
    }, 30_000);
    this.timer.unref();
    void this.tick().catch((error) => this.options.onError?.(error));
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  /** Routine id → the run in its history that is still going. */
  activeRuns = new Map<string, string>();
  /** Conversation id → the routine's turn in it, while that turn runs. */
  unattendedTurns = new Map<string, string>();
  summarizing = new Set<string>();
  summaries = new Set<Promise<void>>();
}

export interface Scheduler {
  tick: OmitThisParameter<typeof schedulerRuns.tick>;
  skip: OmitThisParameter<typeof schedulerRuns.skip>;
  runNow: OmitThisParameter<typeof schedulerRuns.runNow>;
  fireTrigger: OmitThisParameter<typeof schedulerRuns.fireTrigger>;
  setApiTokenHint: OmitThisParameter<typeof schedulerRuns.setApiTokenHint>;
  holdForConnection: OmitThisParameter<typeof schedulerRuns.holdForConnection>;
  retargetDefaults: OmitThisParameter<typeof schedulerRuns.retargetDefaults>;
  execute: OmitThisParameter<typeof schedulerRuns.execute>;
  markUnattended: OmitThisParameter<typeof schedulerRuns.markUnattended>;
  followUnattended: OmitThisParameter<typeof schedulerRuns.followUnattended>;
  observeConversation: OmitThisParameter<
    typeof schedulerRuns.observeConversation
  >;
}
installMethods(Scheduler.prototype, schedulerRuns);

export interface Scheduler {
  browserTask: OmitThisParameter<typeof schedulerBrowser.browserTask>;
  browserGrant: OmitThisParameter<typeof schedulerBrowser.browserGrant>;
  browserRevision: OmitThisParameter<typeof schedulerBrowser.browserRevision>;
  browserReadOnly: OmitThisParameter<typeof schedulerBrowser.browserReadOnly>;
  allowBrowserSite: OmitThisParameter<typeof schedulerBrowser.allowBrowserSite>;
  clearBrowserGrant: OmitThisParameter<
    typeof schedulerBrowser.clearBrowserGrant
  >;
  allowedFor: OmitThisParameter<typeof schedulerBrowser.allowedFor>;
  listedAllowed: OmitThisParameter<typeof schedulerBrowser.listedAllowed>;
  removeAllowed: OmitThisParameter<typeof schedulerBrowser.removeAllowed>;
  allow: OmitThisParameter<typeof schedulerBrowser.allow>;
}
installMethods(Scheduler.prototype, schedulerBrowser);

export interface Scheduler {
  migrationBlocked: OmitThisParameter<
    typeof schedulerMigration.migrationBlocked
  >;
  assertMigrationUnlocked: OmitThisParameter<
    typeof schedulerMigration.assertMigrationUnlocked
  >;
  assertMigrationIdle: OmitThisParameter<
    typeof schedulerMigration.assertMigrationIdle
  >;
  beginMigration: OmitThisParameter<typeof schedulerMigration.beginMigration>;
  restoreMigration: OmitThisParameter<
    typeof schedulerMigration.restoreMigration
  >;
  importMigration: OmitThisParameter<typeof schedulerMigration.importMigration>;
  deleteMigration: OmitThisParameter<typeof schedulerMigration.deleteMigration>;
}
installMethods(Scheduler.prototype, schedulerMigration);

export interface Scheduler {
  saveTask: OmitThisParameter<typeof schedulerTasks.saveTask>;
}
installMethods(Scheduler.prototype, schedulerTasks);
