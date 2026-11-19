import fs from "node:fs";
import path from "node:path";
import { nextWakeAt } from "../../shared/routines";
import { writeOfficialStateFile } from "./official-ui-receipts";

/** setTimeout's longest delay (about 24.8 days); a later wake re-arms itself. */
const maxDelayMs = 2 ** 31 - 1;
/** After a wake that failed (the service is down): try again in two minutes. */
export const wakeRetryMs = 2 * 60_000;
const codeArchiveWakeFile = "code-auto-archive-wake.json";

export type AccountWake = { routine: boolean; codeArchive: boolean };

export interface RoutineWakesOptions {
  /** The runner's state folder (`<stateDir>/users/<id>/profile/schedules.json`). */
  stateDir: string;
  wake(userId: number, due: AccountWake): Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/** Wakes account work even when the user has no page open. The account
 * reports separate due times for scheduled tasks and Code PR checks. */
export class RoutineWakes {
  private next = new Map<number, number>();
  private codeArchive = new Map<number, number>();
  private timers = new Map<number, NodeJS.Timeout>();
  private firing = new Set<number>();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: RoutineWakesOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Reads every user's saved schedule and arms their timers. */
  scan() {
    const users = path.join(this.options.stateDir, "users");
    let names: string[];
    try {
      names = fs.readdirSync(users);
    } catch {
      return;
    }
    for (const name of names) {
      const id = Number(name);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const profile = path.join(users, name, "profile");
      try {
        const data: unknown = JSON.parse(
          fs.readFileSync(path.join(profile, "schedules.json"), "utf8"),
        );
        const at = Array.isArray(data) ? nextWakeAt(data) : undefined;
        if (at !== undefined) this.next.set(id, at);
      } catch {
        // No schedules, or an unreadable file (the context reports it).
      }
      try {
        const at: unknown = JSON.parse(
          fs.readFileSync(path.join(profile, codeArchiveWakeFile), "utf8"),
        );
        if (typeof at === "number" && Number.isFinite(at))
          this.codeArchive.set(id, at);
      } catch {
        // Accounts without watched pull requests have no archive wake.
      }
      this.reschedule(id);
    }
  }

  /** The user's next due time (undefined: nothing is scheduled). */
  set(userId: number, at: number | undefined) {
    if (at === undefined) this.next.delete(userId);
    else this.next.set(userId, at);
    this.reschedule(userId);
  }

  setCodeArchive(userId: number, at: number | undefined) {
    const file = path.join(
      this.options.stateDir,
      "users",
      String(userId),
      "profile",
      codeArchiveWakeFile,
    );
    if (at === undefined) {
      fs.rmSync(file, { force: true });
      this.codeArchive.delete(userId);
    } else {
      writeOfficialStateFile(file, at);
      this.codeArchive.set(userId, at);
    }
    this.reschedule(userId);
  }

  /** When a user is next due (tests and diagnostics). */
  dueAt(userId: number) {
    const routine = this.next.get(userId);
    const codeArchive = this.codeArchive.get(userId);
    return routine === undefined
      ? codeArchive
      : codeArchive === undefined
        ? routine
        : Math.min(routine, codeArchive);
  }

  private reschedule(userId: number) {
    clearTimeout(this.timers.get(userId));
    this.timers.delete(userId);
    const at = this.dueAt(userId);
    if (at !== undefined && !this.firing.has(userId))
      this.arm(userId, Math.max(0, at - this.now()));
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(userId: number, delay: number) {
    if (this.stopped) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(userId);
        const at = this.dueAt(userId);
        if (at === undefined) return;
        // Too far ahead for one timer: arm again for what is left.
        if (at - this.now() > 0) return this.arm(userId, at - this.now());
        void this.fire(userId);
      },
      Math.min(delay, maxDelayMs),
    );
    timer.unref?.();
    this.timers.set(userId, timer);
  }

  private async fire(userId: number) {
    this.firing.add(userId);
    try {
      const now = this.now();
      await this.options.wake(userId, {
        routine: (this.next.get(userId) ?? Infinity) <= now,
        codeArchive: (this.codeArchive.get(userId) ?? Infinity) <= now,
      });
    } catch (error) {
      this.options.log?.(
        `claudex-runner: waking user ${userId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.firing.delete(userId);
      const at = this.dueAt(userId);
      if (at !== undefined)
        this.arm(userId, at <= this.now() ? wakeRetryMs : at - this.now());
    }
  }
}
