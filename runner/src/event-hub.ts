/**
 * The runner's event hub (web plan §1.2): every `ctx.push(event)` of a
 * user's WebAppContext comes here, is coalesced per user (coalesce.ts) and
 * leaves as a runner-link `event` frame. Go numbers the events (seq), keeps
 * the resume ring and fans them out to the user's tabs.
 *
 * Pages to open (payments) leave as `open-url` frames. A frame the link would
 * refuse (over `webLimits.linkFrameBytes`) is dropped and logged: the tab
 * catches up from the next event or a snapshot.
 */
import type { AppEvent } from "../../shared/types";
import { webLimits } from "../../shared/web-protocol";
import { type RunnerFrame } from "../../shared/web-runner-frames";
import { Coalescer } from "./coalesce";

export interface FrameSink {
  /** Sends a frame when the link is up; false when it is not. */
  send(frame: RunnerFrame): boolean;
}

export interface EventHubOptions {
  sink: FrameSink;
  delayMs?: number;
  maxFrameBytes?: number;
  log?: (message: string) => void;
}

export class EventHub {
  private users = new Map<number, Coalescer>();
  private readonly delayMs: number;
  private readonly maxFrameBytes: number;
  private readonly log: (message: string) => void;
  /** Events sent and dropped since start (the runner's load report). */
  readonly counts = { sent: 0, dropped: 0 };
  constructor(private options: EventHubOptions) {
    this.delayMs = options.delayMs ?? webLimits.coalesceMs;
    this.maxFrameBytes = options.maxFrameBytes ?? webLimits.linkFrameBytes;
    this.log = options.log ?? ((message) => console.error(message));
  }
  private coalescer(userId: number) {
    let found = this.users.get(userId);
    if (!found) {
      found = new Coalescer({
        delayMs: this.delayMs,
        send: (event) => this.sendEvent(userId, event),
      });
      this.users.set(userId, found);
    }
    return found;
  }
  private sendEvent(userId: number, event: AppEvent) {
    const frame: RunnerFrame = { t: "event", userId, event };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > this.maxFrameBytes) {
      this.counts.dropped++;
      this.log(
        `claudex-runner: dropped a ${event.type} event of ${bytes} bytes (over the link frame limit)`,
      );
      return;
    }
    if (this.options.sink.send(frame)) this.counts.sent++;
    else this.counts.dropped++;
  }
  /** One of the user's events (coalesced). */
  publish(userId: number, event: AppEvent) {
    this.coalescer(userId).push(event);
  }
  /** Opens a page in the user's tabs, after the events before it. */
  openUrl(
    userId: number,
    url: string,
    target: "same-tab" | "new-tab",
    tabId?: string,
  ) {
    this.users.get(userId)?.flush();
    this.options.sink.send({
      t: "open-url",
      userId,
      url,
      target,
      ...(tabId ? { tabId } : {}),
    });
  }
  /** Sends what is waiting for the user now (before a call's result). */
  flush(userId: number) {
    this.users.get(userId)?.flush();
  }
  /** Forgets the user (context closed); waiting events are dropped. */
  forget(userId: number) {
    this.users.get(userId)?.dispose();
    this.users.delete(userId);
  }
  flushAll() {
    for (const coalescer of this.users.values()) coalescer.flush();
  }
}
