/** Serializes optimistic settings edits so a slow earlier save cannot overwrite a later drag result. */
export class SettingsWriteQueue<T extends object> {
  private desired?: T;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private current: () => T,
    private publish: (value: T) => void,
    private save: (value: T) => Promise<T>,
    private recover: () => Promise<T>,
  ) {}
  update(patch: Partial<T>): Promise<T> {
    const next = { ...(this.desired ?? this.current()), ...patch } as T;
    this.desired = next;
    this.publish(next);
    const task = this.tail
      .then(() => this.save(next))
      .then(
        (saved) => {
          // Once nothing is pending, later edits start from the published
          // settings again, which may carry changes the main process made.
          if (this.desired === next) {
            this.desired = undefined;
            this.publish(saved);
          }
          return saved;
        },
        async (error) => {
          if (this.desired === next) {
            try {
              this.desired = undefined;
              const actual = await this.recover();
              // A newer edit made meanwhile stays on screen.
              if (this.desired === undefined) this.publish(actual);
            } catch {
              /* The original save error remains the actionable failure. */
            }
          }
          throw error;
        },
      );
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
