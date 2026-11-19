import { randomUUID } from "node:crypto";
import type { CodeRunAdmission, CodeSendStart } from "../../electron/engine/code-send-start";
import type { AppEvent, Conversation, Turn } from "../../shared/types";
import { webErrorCodes } from "../../shared/web-protocol";

type ExitReason = "completed" | "failed" | "interrupted" | "error" | "timeout" | "runner-lost";
type Request = (operation: string, userId: number, body: object) => Promise<unknown>;
type Link = { enabled: boolean };

interface CodeRun {
  userId: number;
  conversation: Conversation;
  start: CodeSendStart;
  subscribe(listener: (event: AppEvent) => void): () => void;
}

interface ActiveRun {
  userId: number;
  expire(): void;
  disconnect(): void;
}

const unavailable = () => Object.assign(
  new Error("The Claudex service is not reachable. Try again."),
  { code: webErrorCodes.runnerUnavailable },
);

export class CodeRunCapacity {
  private link: Link | undefined;
  private readonly active = new Map<string, ActiveRun>();
  private readonly finishing = new Map<string, Promise<unknown>>();

  constructor(private request: Request, private log: (message: string) => void) {}

  welcome(enabled: boolean) {
    this.link = { enabled };
  }

  down() {
    this.link = undefined;
    for (const run of this.active.values()) run.disconnect();
  }

  expire(userId: number, runId: string) {
    const run = this.active.get(runId);
    if (run?.userId === userId) run.expire();
  }

  async acquire({ userId, conversation, start, subscribe }: CodeRun): Promise<CodeRunAdmission | undefined> {
    const link = this.link;
    if (!link) throw unavailable();
    if (!link.enabled) return;
    const key = `${userId}:${conversation.id}`;
    await this.finishing.get(key);
    if (this.link !== link) throw unavailable();
    start.signal.throwIfAborted();

    const runId = randomUUID();
    const finish = (exitReason: ExitReason) => {
      if (this.link !== link) return;
      const finishing = this.request("run.finish", userId, { runId, exitReason }).catch(() => {
        this.log("claudex-runner: Code run release was not acknowledged");
      }).finally(() => {
        if (this.finishing.get(key) === finishing) this.finishing.delete(key);
      });
      this.finishing.set(key, finishing);
    };
    let deadline: number;
    try {
      const answer = await this.request("run.acquire", userId, { runId, conversationId: conversation.id });
      if (this.link !== link) throw unavailable();
      start.signal.throwIfAborted();
      if (!answer || typeof answer !== "object" || !("deadlineMs" in answer) ||
          typeof answer.deadlineMs !== "number" || !Number.isSafeInteger(answer.deadlineMs) ||
          answer.deadlineMs <= Date.now())
        throw unavailable();
      deadline = answer.deadlineMs;
    } catch (error) {
      finish("error");
      throw error;
    }

    let off: () => void = () => {};
    const end = (reason: ExitReason) => {
      if (!this.active.delete(runId)) return;
      clearTimeout(timer);
      off();
      finish(reason);
    };
    const stop = (reason: "timeout" | "runner-lost") => {
      end(reason);
      void start.stop().catch(() => {
        this.log("claudex-runner: could not confirm that a revoked Code run stopped");
      });
    };
    const timer = setTimeout(() => stop("timeout"), deadline - Date.now());
    timer.unref();
    this.active.set(runId, { userId, expire: () => stop("timeout"), disconnect: () => stop("runner-lost") });
    let turn: Turn | undefined;
    off = subscribe((event) => {
      if (event.type !== "conversation" || event.conversation.id !== conversation.id) return;
      if (!turn || (start.dispatchUncertain && turn.status === "failed" && event.settledCodeTurnId !== turn.id)) return;
      if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
        end(turn.status);
    });
    return { track: (actual) => { turn = actual; }, abandon: () => end("error") };
  }
}
