import { createHash } from "node:crypto";
import type {
  Routine,
  RoutineBackend,
  RoutineCapabilities,
  RoutineDetailResult,
  RoutineInput,
} from "../../shared/routines";
import { repeatOf } from "../../shared/routine-labels";
import {
  migrationCapabilities,
  migrationTimeZoneReasons,
  migrationTargetReasons,
  routineMigrationReasons,
  type RoutineMigrationBeginResult,
  type RoutineMigrationCheck,
  type RoutineMigrationDeleteResult,
  type RoutineMigrationEligibility,
  type RoutineMigrationReason,
  type RoutineMigrationRequest,
  type RoutineMigrationResult,
} from "../../shared/routine-migration";
import {
  sameMigrationOwner,
  type RoutineMigrationContext,
  type RoutineMigrationRecord,
} from "./routine-migration-registry";

export interface RoutineMigrationDeps {
  context: RoutineMigrationContext;
  current(): boolean;
  call(side: RoutineBackend, method: string, args: unknown[]): Promise<unknown>;
  now?(): number;
}
const check = (reasons: RoutineMigrationReason[]): RoutineMigrationCheck => ({
  ok: reasons.length === 0,
  reasons: [...new Set(reasons)],
});
const unavailable = () => check(["unavailable"]);
const validTask = (value: unknown): value is Routine =>
  Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Routine).id === "string" &&
    typeof (value as Routine).prompt === "string" &&
    Number.isFinite((value as Routine).createdAt),
  );

/** The local origin remains locked and retains its real local history.
 * Cloud receives only editable task fields and its opaque idempotency key. */
export class RoutineMigration {
  constructor(private deps: RoutineMigrationDeps) {}
  private current() {
    if (!this.deps.current())
      throw new Error("The signed-in account changed. Try again.");
  }
  private records() {
    this.current();
    return this.deps.context.journal
      .list()
      .filter((record) =>
        sameMigrationOwner(record.owner, this.deps.context.owner),
      );
  }
  private store(record: RoutineMigrationRecord) {
    this.current();
    this.deps.context.journal.put(record);
  }
  private async call(
    side: RoutineBackend,
    method: string,
    args: unknown[] = [],
  ) {
    this.current();
    const value = await this.deps.call(side, method, args);
    this.current();
    return value;
  }
  private async read(side: RoutineBackend, id: string) {
    const result = (await this.call(side, "readSchedule", [
      id,
    ])) as RoutineDetailResult;
    if (result?.status === "missing") return undefined;
    if (
      result?.status !== "ready" ||
      !validTask(result.task) ||
      result.task.id !== id
    )
      throw new Error("Couldn’t read this scheduled task for migration.");
    return { ...result.task, executionLocation: side };
  }
  private async capabilities(side: RoutineBackend) {
    return (await this.call(
      side,
      "routineCapabilities",
    )) as RoutineCapabilities;
  }
  hiddenLocalIds() {
    return new Set(
      this.records()
        .filter((record) => ["cloud", "reverting"].includes(record.state))
        .map((record) => record.original.id),
    );
  }

  async eligibility(
    id: string,
    source?: RoutineBackend,
  ): Promise<RoutineMigrationEligibility> {
    if (
      typeof id !== "string" ||
      !id ||
      (source !== undefined && source !== "local" && source !== "remote")
    )
      throw new Error("Invalid scheduled task migration.");
    const records = this.records();
    const linked = records.find(
      (record) =>
        record.state !== "local" &&
        (record.remoteId === id || record.original.id === id),
    );
    const local = await this.read("local", linked?.original.id ?? id);
    const backend =
      source ??
      (linked?.remoteId === id ? "remote" : local ? "local" : "remote");
    const remoteRead =
      linked?.state === "remote-deleted"
        ? undefined
        : linked?.remoteId
          ? await this.read("remote", linked.remoteId)
          : backend === "remote"
            ? await this.read("remote", id)
            : undefined;
    const remote =
      linked && ["reverting", "remote-deleted"].includes(linked.state)
        ? (remoteRead ?? linked.cloudBefore)
        : remoteRead;
    const localCapabilities = await this.capabilities("local");
    let remoteCapabilities: RoutineCapabilities | undefined;
    try {
      remoteCapabilities = await this.capabilities("remote");
    } catch {
      this.current();
    }
    const localSupport = migrationCapabilities(localCapabilities);
    const remoteSupport = migrationCapabilities(remoteCapabilities);
    let toCloud: RoutineMigrationCheck = unavailable();
    let toLocal: RoutineMigrationCheck = check(["not_origin"]);
    const pendingForward =
      linked && ["prepared", "origin-locked"].includes(linked.state);
    if (backend === "local" && local && (!linked || pendingForward)) {
      const original = pendingForward ? linked.original : local;
      const reasons = routineMigrationReasons(original, this.deps.now?.());
      if (
        !localSupport?.originLock ||
        !remoteSupport?.import ||
        !remoteSupport.deleteHistory
      )
        reasons.push("unavailable");
      reasons.push(
        ...migrationTargetReasons(original, remoteCapabilities),
        ...migrationTimeZoneReasons(
          original,
          localSupport?.timeZone,
          remoteSupport?.timeZone,
        ),
      );
      toCloud = check(reasons);
    }
    if (
      linked &&
      linked.remoteId &&
      ["cloud", "reverting", "remote-deleted"].includes(linked.state)
    ) {
      const reasons: RoutineMigrationReason[] = [];
      if (!local || local.createdAt !== linked.original.createdAt)
        reasons.push("origin_missing");
      if (
        !localSupport?.originLock ||
        (linked.state !== "remote-deleted" && !remoteSupport?.deleteHistory)
      )
        reasons.push("unavailable");
      reasons.push(
        ...migrationTargetReasons(linked.original, localCapabilities),
        ...migrationTimeZoneReasons(
          linked.original,
          linked.originalTimeZone,
          localSupport?.timeZone,
        ),
      );
      if (!remote) reasons.push("missing");
      if (remote && linked.state === "cloud") {
        if (!remote.enabled) reasons.push("paused");
        if (["starting", "running"].includes(remote.lastRunStatus ?? ""))
          reasons.push("running");
        const now = this.deps.now?.() ?? Date.now();
        const cloudRepeat = repeatOf(remote),
          originalRepeat = repeatOf(linked.original);
        if (
          (cloudRepeat.kind === "once" && cloudRepeat.at <= now) ||
          (originalRepeat.kind === "once" &&
            originalRepeat.at <= now &&
            linked.original.lastRunAt === undefined)
        )
          reasons.push("expired_once");
      }
      toLocal = check(reasons);
    }
    return {
      source: backend,
      toCloud,
      toLocal,
      ...(linked && !["cloud", "local"].includes(linked.state)
        ? { pending: true }
        : {}),
    };
  }

  async move(
    request: RoutineMigrationRequest,
  ): Promise<RoutineMigrationResult> {
    if (
      !request ||
      typeof request.id !== "string" ||
      !request.id ||
      !["to-cloud", "to-local"].includes(request.direction)
    )
      throw new Error("Invalid scheduled task migration.");
    const records = this.records();
    const active = records.find(
      (record) =>
        record.state !== "local" &&
        (record.original.id === request.id || record.remoteId === request.id),
    );
    if (request.direction === "to-cloud" && active?.state === "cloud") {
      const task = await this.read("remote", active.remoteId!);
      if (!task) throw new Error("The cloud task no longer exists.");
      return {
        task,
        fromId: active.original.id,
        toId: task.id,
        history: "local-retained",
      };
    }
    if (request.direction === "to-local" && !active) {
      const completed = records.find(
        (record) => record.state === "local" && record.remoteId === request.id,
      );
      if (completed) {
        const task = await this.read("local", completed.original.id);
        if (!task) throw new Error("The local task no longer exists.");
        return {
          task,
          fromId: request.id,
          toId: task.id,
          history: "cloud-deleted",
        };
      }
    }
    const eligibility = await this.eligibility(
      request.id,
      request.direction === "to-cloud"
        ? "local"
        : active?.remoteId === request.id
          ? "remote"
          : undefined,
    );
    const allowed =
      request.direction === "to-cloud"
        ? eligibility.toCloud
        : eligibility.toLocal;
    if (!allowed.ok)
      throw new Error(
        `This task cannot move ${request.direction === "to-cloud" ? "to the cloud" : "back to this computer"}: ${allowed.reasons.join(", ")}.`,
      );
    return request.direction === "to-cloud"
      ? this.forward(request.id, active)
      : this.back(active!);
  }

  private async forward(
    id: string,
    existing?: RoutineMigrationRecord,
  ): Promise<RoutineMigrationResult> {
    let record = existing;
    if (!record) {
      const original = await this.read("local", id);
      if (!original) throw new Error("This scheduled task no longer exists.");
      const previous = this.records()
        .filter(
          (item) =>
            item.original.id === id &&
            item.original.createdAt === original.createdAt,
        )
        .at(-1);
      const key = `rm1-${createHash("sha256")
        .update(
          JSON.stringify([
            this.deps.context.owner,
            original.id,
            original.createdAt,
            previous?.key ?? "-",
          ]),
        )
        .digest("hex")}`;
      record = {
        key,
        owner: this.deps.context.owner,
        original,
        originalTimeZone: migrationCapabilities(
          await this.capabilities("local"),
        )?.timeZone,
        state: "prepared",
        updatedAt: this.deps.now?.() ?? Date.now(),
      };
      this.store(record);
    }
    if (record.state === "prepared") {
      const result = (await this.call("local", "beginRoutineMigration", [
        {
          key: record.key,
          id: record.original.id,
          expectedUpdatedAt: record.original.updatedAt,
        },
      ])) as RoutineMigrationBeginResult;
      if (
        !validTask(result?.task) ||
        result.task.id !== record.original.id ||
        result.task.createdAt !== record.original.createdAt
      )
        throw new Error("The local task migration was not confirmed.");
      record = { ...record, original: result.task, state: "origin-locked" };
      this.store(record);
    }
    // An uncertain import is retried with the same durable key. Restoring the
    // origin here could duplicate execution if the remote reply was lost.
    const capabilities = await this.capabilities("remote");
    const target = migrationCapabilities(capabilities)!;
    const source = record.original;
    const task: RoutineInput = {
      name: source.name,
      prompt: source.prompt,
      mode: source.mode,
      providerId: source.defaultModel
        ? target.defaultModel!.providerId
        : source.providerId,
      model: source.defaultModel ? target.defaultModel!.model : source.model,
      frequency: source.frequency,
      nextRunAt: source.nextRunAt,
      enabled: source.enabled,
      executionLocation: "remote",
      description: source.description,
      repeat: source.repeat,
      permission: source.permission,
      defaultModel: source.defaultModel,
      disableJitter: source.disableJitter,
      notifyOnCompletion: source.notifyOnCompletion,
      alwaysAllowed: source.alwaysAllowed?.filter(
        (approval) => !approval.pattern,
      ),
    };
    let imported: unknown;
    try {
      imported = await this.call("remote", "importRoutineMigration", [
        { key: record.key, task },
      ]);
    } catch (error) {
      this.current();
      if (
        (error as { code?: unknown })?.code === "CLAUDEX_MIGRATION_NOT_CREATED"
      ) {
        const restored = await this.call("local", "restoreRoutineMigration", [
          { key: record.key, id: source.id, prompt: source.prompt },
        ]);
        if (!validTask(restored) || restored.id !== source.id)
          throw new Error(
            "The local task migration was not confirmed. Retry this move.",
          );
        this.store({ ...record, state: "local" });
      }
      throw error;
    }
    if (!validTask(imported))
      throw new Error(
        "The cloud task migration was not confirmed. Retry this move.",
      );
    record = { ...record, remoteId: imported.id, state: "cloud" };
    this.store(record);
    return {
      task: { ...imported, executionLocation: "remote" },
      fromId: source.id,
      toId: imported.id,
      history: "local-retained",
    };
  }

  private async back(
    initial: RoutineMigrationRecord,
  ): Promise<RoutineMigrationResult> {
    let record = initial;
    if (record.state === "cloud") {
      const cloud = await this.read("remote", record.remoteId!);
      if (!cloud) throw new Error("The cloud task no longer exists.");
      record = {
        ...record,
        cloudBefore: cloud,
        restoredPrompt: cloud.prompt,
        state: "reverting",
      };
      this.store(record);
    }
    if (record.state === "reverting") {
      const remote = await this.read("remote", record.remoteId!);
      if (remote) {
        if (["starting", "running"].includes(remote.lastRunStatus ?? ""))
          throw new Error(
            "Another task is running. Try again when it finishes.",
          );
        record = {
          ...record,
          cloudBefore: remote,
          restoredPrompt: remote.prompt,
        };
        this.store(record);
        await this.call("remote", "saveSchedule", [
          { ...remote, enabled: false },
        ]);
      }
      const deleted = (await this.call("remote", "deleteRoutineMigration", [
        { key: record.key, id: record.remoteId! },
      ])) as RoutineMigrationDeleteResult;
      if (deleted?.deleted !== true || deleted.historyDeleted !== true)
        throw new Error(
          "Cloud task history deletion was not confirmed. Retry this move.",
        );
      record = { ...record, state: "remote-deleted" };
      this.store(record);
    }
    const restored = await this.call("local", "restoreRoutineMigration", [
      {
        key: record.key,
        id: record.original.id,
        prompt: record.restoredPrompt!,
      },
    ]);
    if (!validTask(restored) || restored.id !== record.original.id)
      throw new Error(
        "The local task migration was not confirmed. Retry this move.",
      );
    this.store({ ...record, state: "local" });
    return {
      task: { ...restored, executionLocation: "local" },
      fromId: record.remoteId!,
      toId: restored.id,
      history: "cloud-deleted",
    };
  }
}
