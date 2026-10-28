import { randomUUID } from "node:crypto";
import { nextCron } from "../../shared/cron";
import {
  sessionLoopLifetime,
  type SessionLoop,
  type SessionLoopInput,
} from "../../shared/session-loops";

export const maxSessionLoops = 50;

export class SessionLoops {
  private loops = new Map<string, SessionLoop>();
  private sending = new Set<string>();
  private retryAt = new Map<string, number>();

  constructor(
    private host: {
      available(conversationId: string): "idle" | "busy" | "gone";
      send(conversationId: string, prompt: string): Promise<unknown>;
      onError?(error: unknown): void;
    },
  ) {}

  list(conversationId: string) {
    return [...this.loops.values()]
      .filter((loop) => loop.conversationId === conversationId)
      .map((loop) => ({ ...loop }));
  }

  create(conversationId: string, input: SessionLoopInput, now = Date.now()) {
    // A session keeps a bounded number of loops (each can send on its own).
    if (this.list(conversationId).length >= maxSessionLoops)
      throw Error(
        `A session can have up to ${maxSessionLoops} loops. Stop one first.`,
      );
    const nextRunAt = nextCron(input.cron, now, true);
    if (!nextRunAt)
      throw Error(
        "Invalid cron expression. Check the format (for example: 0 9 * * *).",
      );
    const loop: SessionLoop = {
      ...input,
      conversationId,
      id: randomUUID(),
      createdAt: now,
      recurring: input.recurring !== false,
      nextRunAt,
    };
    this.loops.set(loop.id, loop);
    return { ...loop };
  }

  stop(conversationId: string, id: string) {
    if (this.loops.get(id)?.conversationId !== conversationId) return false;
    this.retryAt.delete(id);
    return this.loops.delete(id);
  }

  clear() {
    this.loops.clear();
    this.retryAt.clear();
  }

  async tick(now = Date.now()) {
    for (const loop of this.loops.values()) {
      const state = this.host.available(loop.conversationId);
      const expired =
        !loop.recurring &&
        loop.nextRunAt <= loop.createdAt + sessionLoopLifetime
          ? now >= loop.nextRunAt + 120000
          : now > loop.createdAt + sessionLoopLifetime;
      if (state === "gone" || expired) {
        this.stop(loop.conversationId, loop.id);
        continue;
      }
      if (
        state === "busy" ||
        loop.nextRunAt > now ||
        (this.retryAt.get(loop.id) ?? 0) > now ||
        this.sending.has(loop.conversationId)
      )
        continue;
      this.sending.add(loop.conversationId);
      try {
        await this.host.send(loop.conversationId, loop.prompt);
        if (!loop.recurring) this.loops.delete(loop.id);
        else loop.nextRunAt = nextCron(loop.cron, now, true)!;
        this.retryAt.delete(loop.id);
      } catch (error) {
        if (this.loops.has(loop.id)) this.retryAt.set(loop.id, now + 60000);
        this.host.onError?.(error);
      } finally {
        this.sending.delete(loop.conversationId);
      }
    }
  }
}
