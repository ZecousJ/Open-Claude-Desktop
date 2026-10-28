// .
export const stealthIdleMs = 10 * 60_000;
export const stealthRetryMs = 30_000;

export interface StealthState {
  enabled: boolean;
  ready: boolean;
  failed: boolean;
  busy: boolean;
  focused: boolean;
  fullScreen: boolean;
  checking: boolean;
}

export class StealthUpdate {
  private idleSince: number | undefined;
  private triggered = false;
  private retryAt: number | undefined;

  constructor(private readonly install: () => void) {}

  update(state: StealthState, now = Date.now()) {
    if (
      !state.enabled ||
      !state.ready ||
      state.failed ||
      state.busy ||
      state.focused ||
      state.fullScreen
    ) {
      this.idleSince = undefined;
      this.retryAt = undefined;
      return;
    }
    this.idleSince ??= now;
    if (
      this.triggered ||
      now - this.idleSince < stealthIdleMs ||
      now < (this.retryAt ?? 0)
    )
      return;
    if (state.checking) {
      this.retryAt = now + stealthRetryMs;
      return;
    }
    this.triggered = true;
    this.install();
  }
}

export interface StealthWindow {
  visible: boolean;
  minimized: boolean;
}
