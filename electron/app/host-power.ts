import { Listeners } from "./app-context";

const historyAgeMs = 15 * 60_000;
type SleepInterval = { fromMs: number; toMs: number };

export class HostPowerHistory {
  private suspendedSinceMs?: number;
  private recentSleeps: SleepInterval[] = [];
  private readonly changed = new Listeners<void>();

  snapshot(now = Date.now()) {
    this.recentSleeps = this.recentSleeps.filter(sleep => now - sleep.toMs <= historyAgeMs);
    return {
      ...(this.suspendedSinceMs === undefined ? {} : { suspendedSinceMs: this.suspendedSinceMs }),
      recentSleeps: this.recentSleeps.map(sleep => ({ ...sleep })),
      recentStalls: [],
    };
  }

  subscribe(listener: () => void) {
    return this.changed.add(listener);
  }

  suspend(now = Date.now()) {
    if (this.suspendedSinceMs !== undefined) return;
    this.suspendedSinceMs = now;
    this.changed.emit();
  }

  resume(now = Date.now()) {
    const fromMs = this.suspendedSinceMs;
    if (fromMs === undefined) return;
    this.suspendedSinceMs = undefined;
    if (now < fromMs) {
      this.changed.emit();
      return;
    }
    const sleep = { fromMs, toMs: now };
    this.recentSleeps.push(sleep);
    this.changed.emit();
    return { ...sleep };
  }
}

export const hostPowerHistory = new HostPowerHistory();
