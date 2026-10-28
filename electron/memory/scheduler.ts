/**
 * When the memory summary runs (R3 design 3.6): about once a day while the
 * app is open, soon after "Generate memory from chats" is turned on, and
 * whenever something asks for it. A run that failed is tried again after an
 * hour. A run never starts while a reply is being written, and none starts
 * while memory is off.
 *
 * Time is injectable so the schedule can be tested without waiting.
 */
import type { RunResult } from "./synthesizer";

export const dayMs = 24 * 60 * 60 * 1000;
/** Least time before a failed run is tried again. */
export const retryMs = 60 * 60 * 1000;
/** How often the schedule checks whether a run is due. */
export const checkMs = 15 * 60 * 1000;
/** First check after the app opens (the app is busy starting then). */
export const firstCheckMs = 2 * 60 * 1000;
/** Wait after turning memory on, or after a busy moment. */
export const soonMs = 15 * 1000;
/** Wait before reading the rest when a run left chats for later. */
export const moreMs = 10 * 60 * 1000;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface MemorySchedulerDeps {
  /** Memory may run now (turned on and allowed). */
  enabled(): boolean;
  /** A reply is being written; the summary waits. */
  busy(): boolean;
  /** When the task last looked for something new. */
  lastAttemptAt(): number;
  lastRunFailed(): boolean;
  run(): Promise<RunResult>;
  now?(): number;
  timers?: Timers;
}

export class MemoryScheduler {
  private handle: unknown;
  private stopped = true;
  private running = false;
  private readonly now: () => number;
  private readonly timers: Timers;
  constructor(private deps: MemorySchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
  }

  /** Whether a scheduled run is due now. */
  due(): boolean {
    const wait = this.deps.lastRunFailed() ? retryMs : dayMs;
    return this.now() - this.deps.lastAttemptAt() >= wait;
  }

  start() {
    this.stopped = false;
    this.plan(firstCheckMs);
  }

  stop() {
    this.stopped = true;
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
  }

  /** Runs soon regardless of the daily rhythm (memory was just turned on). */
  runSoon(delayMs = soonMs) {
    if (!this.stopped) this.plan(delayMs, true);
  }

  private plan(delayMs: number, force = false) {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => {
      this.handle = undefined;
      void this.tick(force);
    }, delayMs);
  }

  /** One check: runs the summary when memory is on, the app is idle and a run is due (or forced). */
  async tick(force = false): Promise<void> {
    if (this.stopped || this.running) return;
    let next = checkMs;
    if (this.deps.enabled() && (force || this.due())) {
      if (this.deps.busy()) {
        // Look again shortly, keeping a forced run forced.
        this.plan(soonMs * 4, force);
        return;
      } else {
        this.running = true;
        try {
          const result = await this.deps.run();
          if (result.more) next = moreMs;
        } catch (error) {
          console.error(
            "Memory summary failed:",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.running = false;
        }
      }
    }
    if (!this.stopped) this.plan(next);
  }
}
