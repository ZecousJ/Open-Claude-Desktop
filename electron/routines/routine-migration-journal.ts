import fs from "node:fs";
import path from "node:path";
import type { Routine } from "../../shared/routines";

export const migrationKeyPattern = /^rm1-[a-f0-9]{64}$/;
export function checkedMigrationKey(value: unknown): string {
  if (typeof value !== "string" || !migrationKeyPattern.test(value))
    throw new Error("Invalid scheduled task migration key.");
  return value;
}
export function checkedMigrationId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128)
    throw new Error("Invalid scheduled task migration ID.");
  return value;
}
export interface MigrationStoredRoutine extends Routine {
  /** Only Scheduler writes these; public projections omit both. */
  migrationImportKey?: string;
  migrationRestoreKey?: string;
}
export type SchedulerMigrationRecord =
  | {
      key: string;
      kind: "origin";
      id: string;
      state: "locked" | "restored";
      task: Routine;
    }
  | { key: string; kind: "deleted"; id: string; completed?: true };

/** Separate from the desktop coordinator's account/service/device registry.
 * A lock/tombstone reaches disk before changing tasks, so a crash cannot run
 * the old task or resurrect a deleted import. Corruption fails closed. */
export class RoutineMigrationJournal {
  private readonly filename: string;
  private records: SchedulerMigrationRecord[];
  constructor(root: string, validateSnapshot?: (task: Routine) => unknown) {
    this.filename = path.join(root, "routine-migration-scheduler.json");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = [];
        return;
      }
      throw new Error("Scheduled task migration recovery could not be read.");
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      !("version" in raw) ||
      raw.version !== 1 ||
      !("records" in raw) ||
      !Array.isArray(raw.records) ||
      raw.records.length > 10000
    )
      throw new Error("Scheduled task migration recovery could not be read.");
    const keys = new Set<string>();
    for (const record of raw.records) {
      try {
        checkedMigrationKey(record?.key);
        checkedMigrationId(record?.id);
        if (
          keys.has(record.key) ||
          !["origin", "deleted"].includes(record.kind)
        )
          throw Error();
        if (
          record.kind === "origin" &&
          (!["locked", "restored"].includes(record.state) ||
            !record.task ||
            record.task.id !== record.id ||
            typeof record.task.prompt !== "string" ||
            !Number.isFinite(record.task.updatedAt) ||
            !Number.isFinite(record.task.createdAt))
        )
          throw Error();
        if (record.kind === "origin") validateSnapshot?.(record.task);
        if (
          record.kind === "deleted" &&
          record.completed !== undefined &&
          record.completed !== true
        )
          throw Error();
        keys.add(record.key);
      } catch {
        throw new Error("Scheduled task migration recovery could not be read.");
      }
    }
    this.records = raw.records;
  }
  get(key: string): SchedulerMigrationRecord | undefined {
    const record = this.records.find((entry) => entry.key === key);
    return record ? structuredClone(record) : undefined;
  }
  latestOrigin(
    id: string,
  ):
    | Pick<
        Extract<SchedulerMigrationRecord, { kind: "origin" }>,
        "key" | "id" | "state"
      >
    | undefined {
    // Lists/ticks ask only for lock metadata. Avoid cloning large original
    // prompts for every task whenever the scheduler publishes its list.
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index];
      if (record.kind === "origin" && record.id === id)
        return { key: record.key, id: record.id, state: record.state };
    }
    return undefined;
  }
  deletion(
    id: string,
  ): Extract<SchedulerMigrationRecord, { kind: "deleted" }> | undefined {
    const record = this.records.find(
      (entry) => entry.kind === "deleted" && entry.id === id,
    );
    return record?.kind === "deleted" ? structuredClone(record) : undefined;
  }
  deleted(id: string): boolean {
    return Boolean(this.deletion(id));
  }
  put(record: SchedulerMigrationRecord): void {
    checkedMigrationKey(record.key);
    checkedMigrationId(record.id);
    const index = this.records.findIndex((entry) => entry.key === record.key);
    const next = this.records.slice();
    if (index === -1) {
      if (next.length >= 10000)
        throw new Error("Scheduled task migration recovery is full.");
      next.push(structuredClone(record));
    } else next[index] = structuredClone(record);
    const temporary = this.filename + ".tmp";
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: 1, records: next }),
        { mode: 0o600 },
      );
      const descriptor = fs.openSync(temporary, "r+");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.filename);
      this.records = next;
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
}
