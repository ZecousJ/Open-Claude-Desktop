/** Completed work held awake for 10 minutes while away. */
export class KeepAwakeNoticeTracker {
  private sessions = new Map<string, { since: number; awayMs: number }>();
  private completed?: { sessionId: string; heldMs: number };
  observe(
    sessionId: string,
    running: boolean,
    completed: boolean,
    now: number,
    idleMs: number,
  ) {
    const entry = this.sessions.get(sessionId);
    if (running) {
      if (entry)
        entry.awayMs = Math.max(
          entry.awayMs,
          Math.min(idleMs, now - entry.since),
        );
      else this.sessions.set(sessionId, { since: now, awayMs: 0 });
      if (this.completed?.sessionId === sessionId) this.completed = undefined;
    } else if (entry) {
      this.sessions.delete(sessionId);
      const heldMs = now - entry.since;
      if (
        completed &&
        heldMs >= 600_000 &&
        Math.max(entry.awayMs, Math.min(idleMs, heldMs)) >= 600_000
      )
        this.completed = { sessionId, heldMs };
    }
  }
  release(notify: boolean) {
    const completed = notify ? this.completed : undefined;
    this.sessions.clear();
    this.completed = undefined;
    return completed;
  }
}
