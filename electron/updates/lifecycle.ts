import type { UpdatePolicy } from "../../shared/update-policy";

export interface UpdateActivity {
  enabled: boolean;
  version?: string;
  failed: boolean;
  busy: boolean;
  focused: boolean;
  fullScreen: boolean;
  idleSeconds: number;
  checking: boolean;
  windowReady: boolean;
  quitting: boolean;
}

// .
export class UpdateLifecycle {
  private pending?: { version: string; since: number };
  private crashVersion?: string;
  private crashDisarmed = false;
  private triggered = false;
  private lastWorkLog = -Infinity;

  constructor(
    private readonly policy: UpdatePolicy,
    private readonly previousExitUnclean: boolean,
    private readonly launchedAt: number,
    private readonly install: (reason: "unclean-exit" | "enforcement") => void,
    private readonly log: (message: string) => void,
  ) {}

  update(state: UpdateActivity, now = Date.now()) {
    if (this.triggered) return;
    if (!state.enabled || state.quitting) {
      this.crashDisarmed = true;
      return;
    }
    const windowMs = this.policy.uncleanExitInstallWindowMinutes * 60_000;
    const withinWindow = now - this.launchedAt < windowMs;
    if (!state.version) {
      if (!state.checking) {
        this.pending = undefined;
        this.crashVersion = undefined;
        if (!withinWindow) this.crashDisarmed = true;
      }
      return;
    }
    if (this.pending?.version !== state.version)
      this.pending = { version: state.version, since: now };
    if (!this.crashVersion && !withinWindow) this.crashDisarmed = true;
    if (this.previousExitUnclean && !this.crashDisarmed && withinWindow)
      this.crashVersion = state.version;
    else if (this.crashVersion && !this.crashDisarmed)
      this.crashVersion = state.version;
    if (state.failed) this.crashDisarmed = true;
    if (state.failed || state.checking) return;
    if (
      this.crashVersion === state.version &&
      !this.crashDisarmed &&
      !state.busy &&
      state.windowReady &&
      !state.fullScreen &&
      (!state.focused || state.idleSeconds >= 600)
    ) {
      this.triggered = true;
      this.install("unclean-exit");
      return;
    }
    const elapsed = Math.max(0, now - this.pending.since);
    if (elapsed < 600_000) return;
    const pendingHours = 1 + Math.floor(elapsed / 600_000) / 6;
    if (pendingHours < (this.policy.enforcementHours ?? 72)) return;
    if (this.policy.enforcementHours === undefined && state.idleSeconds < 600)
      return;
    if (state.busy) {
      if (now - this.lastWorkLog >= 600_000) {
        this.log(
          `Deferring auto-restart after ${Math.round(pendingHours)} hours: Claudex is working`,
        );
        this.lastWorkLog = now;
      }
      return;
    }
    this.triggered = true;
    this.install("enforcement");
  }
}
