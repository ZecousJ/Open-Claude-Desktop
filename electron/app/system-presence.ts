import { app, powerMonitor } from "electron";

export type PresenceEvent =
  "suspend" | "resume" | "lock" | "unlock" | "session" | "focus";

/** Shared power events and input-cleared lock latch. */
export class SystemPresence {
  private lockedAt?: number;
  private listeners = new Set<(event: PresenceEvent) => void>();
  private cleanup: (() => void)[] = [];
  constructor(
    private monitor: Pick<
      typeof powerMonitor,
      "on" | "off" | "getSystemIdleTime" | "getSystemIdleState"
    > = powerMonitor,
    private application: Pick<typeof app, "on" | "off"> = app,
    private now = Date.now,
  ) {}
  subscribe(listener: (event: PresenceEvent) => void) {
    if (!this.cleanup.length) {
      for (const [native, event] of [
        ["suspend", "suspend"],
        ["resume", "resume"],
        ["lock-screen", "lock"],
        ["unlock-screen", "unlock"],
        ["user-did-become-active", "session"],
      ] as const) {
        const handler = () => this.emit(event);
        (this.monitor.on as (event: string, listener: () => void) => void)(
          native,
          handler,
        );
        this.cleanup.push(() =>
          (this.monitor.off as (event: string, listener: () => void) => void)(
            native,
            handler,
          ),
        );
      }
      const focus = () => this.emit("focus");
      this.application.on("browser-window-focus", focus);
      this.cleanup.push(() =>
        this.application.off("browser-window-focus", focus),
      );
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.cleanup.splice(0).forEach((remove) => remove());
        this.lockedAt = undefined;
      }
    };
  }
  private emit(event: PresenceEvent) {
    if (event === "lock") this.lockedAt = this.now();
    if (event === "unlock") this.lockedAt = undefined;
    for (const listener of this.listeners) listener(event);
  }
  isLocked() {
    if (
      this.lockedAt !== undefined &&
      this.now() - this.monitor.getSystemIdleTime() * 1000 >
        this.lockedAt + 2000
    )
      this.lockedAt = undefined;
    return (
      this.monitor.getSystemIdleState(1) === "locked" ||
      this.lockedAt !== undefined
    );
  }
}

export const systemPresence = new SystemPresence();
