import fs from "node:fs";
import path from "node:path";
import type { Routine } from "../../shared/routines";

export interface RoutineMigrationOwner {
  accountId: string;
  serviceId: string;
  deviceId: string;
}
export interface RoutineMigrationRecord {
  key: string;
  owner: RoutineMigrationOwner;
  original: Routine;
  remoteId?: string;
  originalTimeZone?: string;
  state:
    | "prepared"
    | "origin-locked"
    | "cloud"
    | "reverting"
    | "remote-deleted"
    | "local";
  cloudBefore?: Routine;
  restoredPrompt?: string;
  updatedAt: number;
}
export interface RoutineMigrationJournal {
  list(): RoutineMigrationRecord[];
  put(record: RoutineMigrationRecord): void;
}
export interface RoutineMigrationContext {
  owner: RoutineMigrationOwner;
  journal: RoutineMigrationJournal;
}
export const sameMigrationOwner = (
  left: RoutineMigrationOwner,
  right: RoutineMigrationOwner,
) =>
  left.accountId === right.accountId &&
  left.serviceId === right.serviceId &&
  left.deviceId === right.deviceId;

/** The journal is private to the account's local profile. Nothing in this
 * file, including the snapshot and account/device binding, is sent to cloud. */
export class RoutineMigrationRegistry implements RoutineMigrationJournal {
  private readonly filename: string;
  constructor(root: string) {
    this.filename = path.join(root, "routine-migrations.json");
  }
  list(): RoutineMigrationRecord[] {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Scheduled task migration recovery could not be read.");
    }
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("records" in data) ||
      !Array.isArray(data.records)
    )
      throw new Error("Scheduled task migration recovery could not be read.");
    const records = data.records as RoutineMigrationRecord[];
    if (
      records.length > 10_000 ||
      records.some(
        (record) =>
          !record ||
          !/^rm1-[a-f0-9]{64}$/.test(record.key) ||
          !record.owner ||
          [
            record.owner.accountId,
            record.owner.serviceId,
            record.owner.deviceId,
          ].some((value) => typeof value !== "string" || !value) ||
          !record.original ||
          typeof record.original.id !== "string" ||
          typeof record.original.name !== "string" ||
          typeof record.original.prompt !== "string" ||
          !Number.isFinite(record.original.createdAt) ||
          !Number.isFinite(record.original.updatedAt) ||
          (["cloud", "reverting", "remote-deleted"].includes(record.state) &&
            (typeof record.remoteId !== "string" || !record.remoteId)) ||
          (["reverting", "remote-deleted"].includes(record.state) &&
            typeof record.restoredPrompt !== "string") ||
          ![
            "prepared",
            "origin-locked",
            "cloud",
            "reverting",
            "remote-deleted",
            "local",
          ].includes(record.state) ||
          !Number.isFinite(record.updatedAt),
      )
    )
      throw new Error("Scheduled task migration recovery could not be read.");
    return structuredClone(records);
  }
  put(record: RoutineMigrationRecord) {
    const records = this.list();
    const next = [
      ...records.filter((previous) => previous.key !== record.key),
      structuredClone(record),
    ];
    if (next.length > 10_000)
      throw new Error("Scheduled task migration recovery is full.");
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next }), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filename);
  }
}
