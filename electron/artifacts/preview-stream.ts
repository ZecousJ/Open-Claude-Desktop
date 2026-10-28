/** Demand-driven frames; one capture in flight per source, no queued frames. */
export class PreviewStream<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private fps = 4;
  private subscribed = false;
  private inFlight = false;
  private disposed = false;

  constructor(
    private capture: () => Promise<T>,
    private deliver: (frame: T) => void,
    private onDispose?: () => void,
  ) {}

  setFps(fps: number) {
    this.fps = Math.min(30, Math.max(1, Number.isFinite(fps) ? fps : 4));
  }

  setSubscribed(on: boolean) {
    if (this.disposed) return;
    if (this.subscribed === on) return;
    this.subscribed = on;
    this.generation++;
    clearTimeout(this.timer);
    if (on && !this.inFlight) void this.next();
  }

  dispose() {
    if (this.disposed) return;
    this.setSubscribed(false);
    this.disposed = true;
    this.onDispose?.();
  }

  private async next() {
    if (!this.subscribed || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    const started = Date.now();
    try {
      const frame = await this.capture();
      if (this.subscribed && generation === this.generation)
        this.deliver(frame);
    } catch {
      // A stopped source can be reattached without keeping a stale frame.
    } finally {
      this.inFlight = false;
      if (this.subscribed)
        this.timer = setTimeout(
          () => void this.next(),
          Math.max(0, 1000 / this.fps - (Date.now() - started)),
        );
    }
  }
}
