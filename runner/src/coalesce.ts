/**
 * Per-user event coalescing (web plan §2 #21, W-ARCH §3.4). The engine pushes
 * the whole conversation for every streamed change, a dozen times a second;
 * over the network only the latest copy within a short window matters.
 *
 * - "conversation" events wait `delayMs` (80 ms) and only the newest copy of
 *   each conversation is sent; "engine" state likewise keeps the newest, and
 *   so does a side chat's "side-chat-text" (it carries the whole answer so far).
 * - Any other event first sends everything still waiting, in the order the
 *   waiting keys were first seen, then goes out itself. So an approval or a
 *   deletion never overtakes an older conversation copy (which could bring a
 *   deleted conversation back in the window).
 */
import type { AppEvent } from "../../shared/types";

/** The coalescing key of an event; undefined when it is sent right away. */
export function coalesceKey(event: AppEvent): string | undefined {
  if (event.type === "conversation")
    return `conversation:${event.conversation.id}`;
  if (event.type === "engine") return "engine";
  // Each copy holds the answer so far, so the newest alone is enough.
  if (event.type === "side-chat-text") return `side-chat:${event.sideChatId}`;
  return undefined;
}

export interface CoalescerOptions {
  delayMs: number;
  send(event: AppEvent): void;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** One user's outgoing events. */
export class Coalescer {
  private pending = new Map<string, AppEvent>();
  private timer: unknown;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  constructor(private options: CoalescerOptions) {
    this.setTimer =
      options.setTimer ??
      ((cb, ms) => {
        const timer = setTimeout(cb, ms);
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }
  push(event: AppEvent) {
    const key = coalesceKey(event);
    if (key === undefined) {
      this.flush();
      this.options.send(event);
      return;
    }
    // A newer copy keeps the place of the first waiting one.
    this.pending.set(key, event);
    if (this.timer === undefined)
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.flush();
      }, this.options.delayMs);
  }
  /** Sends everything waiting now. */
  flush() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const event of waiting) this.options.send(event);
  }
  get waiting() {
    return this.pending.size;
  }
  /** Drops what is waiting (the user's context closed). */
  dispose() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
