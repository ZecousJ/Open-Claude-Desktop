import fs from "node:fs";
import path from "node:path";
import { nextWakeAt } from "../../shared/routines";

/** setTimeout's longest delay (about 24.8 days); a later wake re-arms itself. */
const maxDelayMs = 2 ** 31 - 1;
/** After a wake that failed (the service is down): try again in two minutes. */
export const wakeRetryMs = 2 * 60_000;

export interface RoutineWakesOptions {
  /** The runner's state folder (`<stateDir>/users/<id>/profile/schedules.json`). */
  stateDir: string;
  /** Opens the user's context so its scheduler starts what is due. */
  wake(userId: number): Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Wakes users whose scheduled tasks are due while no page of theirs is open.
 * The tasks live in the user's own profile (electron/scheduler.ts); this only
 * remembers when each user is next due. It learns that at start from the
 * `schedules.json` files, and afterwards from the contexts (`set`, whenever a
 * user's schedule changes). A due user is woken once: their context then runs
 * the task and reports the next time.
 */
export class RoutineWakes {
  private next = new Map<number, number>();
  private timers = new Map<number, NodeJS.Timeout>();
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
      try {
        const data: unknown = JSON.parse(
          fs.readFileSync(
            path.join(users, name, "profile", "schedules.json"),
            "utf8",
          ),
        );
        if (Array.isArray(data)) this.set(id, nextWakeAt(data));
      } catch {
        // No schedules, or an unreadable file (the context reports it).
      }
    }
  }

  /** The user's next due time (undefined: nothing is scheduled). */
  set(userId: number, at: number | undefined) {
    clearTimeout(this.timers.get(userId));
    this.timers.delete(userId);
    if (at === undefined) {
      this.next.delete(userId);
      return;
    }
    this.next.set(userId, at);
    this.arm(userId, Math.max(0, at - this.now()));
  }

  /** When a user is next due (tests and diagnostics). */
  dueAt(userId: number) {
    return this.next.get(userId);
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
        const at = this.next.get(userId);
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
    try {
      await this.options.wake(userId);
    } catch (error) {
      this.options.log?.(
        `claudex-runner: waking user ${userId} for a scheduled task failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Still due: try again soon, unless the context reported a newer time.
      if (!this.timers.has(userId) && this.next.has(userId))
        this.arm(userId, wakeRetryMs);
      return;
    }
    // The context runs the due task and reports the next time through `set`.
    // Should it not (its scheduler was busy), look again shortly.
    const at = this.next.get(userId);
    if (at !== undefined && at <= this.now() && !this.timers.has(userId))
      this.arm(userId, wakeRetryMs);
  }
}
