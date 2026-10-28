export class EmailSignInWindows<Window extends { isDestroyed(): boolean }> {
  private requests = new Map<string, { window: Window; expiresAt: number }>();

  constructor(private now = Date.now) {}

  remember(request: string, window: Window) {
    for (const [key, pending] of this.requests) {
      if (
        pending.window === window ||
        pending.window.isDestroyed() ||
        pending.expiresAt <= this.now()
      )
        this.requests.delete(key);
    }
    this.requests.set(request, { window, expiresAt: this.now() + 600_000 });
  }

  owner(request: string): Window | undefined {
    const pending = this.requests.get(request);
    if (!pending) return;
    if (pending.window.isDestroyed() || pending.expiresAt <= this.now()) {
      this.requests.delete(request);
      return;
    }
    return pending.window;
  }
}
