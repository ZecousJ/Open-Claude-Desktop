import type {
  AppEvent,
  Conversation,
  Mode,
  Project,
  Provider,
} from "../../shared/types";
import type { ClientPolicy } from "../../shared/client-policy";
import { updateRefusal } from "../../shared/client-policy-rules";
import { effortForMode } from "../../shared/code-effort";
import {
  isContextLimitError,
  isLengthLimitError,
} from "../../shared/turn-errors";
import { isOutboxTurn } from "../ssh/outbox";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { ProviderServiceClient } from "./provider-service-client";
import type { CodexRPC } from "./rpc";
import type { Store } from "../store/store";
import {
  maxSideChats,
  maxSideQuestionLength,
  sideAnswer,
  sideContextFull,
  type SideChat,
} from "./side-chat-model";
import { reloadOptions, type ThreadOptions } from "./thread-options";

/** What the side chats need from the engine that runs them. */
export interface SideChatHost {
  rpc(): CodexRPC | undefined;
  gateway(): ProviderServiceClient | undefined;
  store(): Store;
  policy(): ClientPolicy;
  lastRefusal(): (GatewayRefusal & { at: number }) | undefined;
  emit(event: AppEvent): void;
  assertModel(provider: Provider, model: string): void;
  ensure(provider: Provider): Promise<void>;
  threadOptions(
    c: Conversation,
    provider: Provider,
    model: string,
    mode: Mode,
    project?: Project,
  ): ThreadOptions;
  loaded(threadId: string): boolean;
  ensureThread(c: Conversation, options: ThreadOptions): Promise<unknown>;
}

/**
 * Side chats (askSideChat) and the handoff note: questions answered on an
 * ephemeral fork of the conversation's thread, by id, with their threads'
 * ids back to them. Their thread notifications come here, not to the
 * conversation.
 */
export class SideChats {
  private chats = new Map<string, SideChat>();
  private threads = new Map<string, string>();
  constructor(private host: SideChatHost) {}

  /** The side chat a thread belongs to, if it is one. */
  chatOfThread(threadId: unknown) {
    return typeof threadId === "string"
      ? this.threads.get(threadId)
      : undefined;
  }

  /**
   * Asks `question` on the ephemeral fork named `sideChatId`: a side chat's
   * questions, and the handoff note. `instructions` tell the fork how to
   * answer; `stream` sends the answer so far to the window as it is written.
   */
  async ask(
    id: string,
    sideChatId: string,
    question: string,
    instructions: string,
    stream = false,
  ): Promise<string> {
    const text = question.trim();
    if (!text) throw new Error("Enter a question.");
    if (text.length > maxSideQuestionLength)
      throw new Error("This question is too long.");
    const c = this.host.store().conversation(id);
    const existing = this.chats.get(sideChatId);
    if (existing && existing.conversationId !== id)
      throw new Error("This side chat belongs to another conversation.");
    if (existing?.turn) throw new Error("The side chat is still answering.");
    const provider = this.host
      .store()
      .settings.providers.find((p) => p.id === c.providerId);
    if (!provider) throw new Error("The model service is unavailable.");
    this.host.assertModel(provider, c.model);
    if (this.host.policy().update?.state === "required")
      throw new Error(updateRefusal(this.host.policy().update!));
    const side = existing ?? this.open(sideChatId, id);
    const startedAt = Date.now();
    // Registered before anything is awaited: the next question sees this one running.
    const answer = new Promise<string>((resolve, reject) => {
      side.turn = { messages: new Map(), stream, resolve, reject };
    });
    answer.catch(() => {});
    const cancelled = () => this.chats.get(sideChatId) !== side;
    try {
      await this.host.ensure(provider);
      if (cancelled()) throw new Error("The side chat was closed.");
      side.threadId ??= await this.fork(c, provider, sideChatId, instructions);
      if (cancelled()) throw new Error("The side chat was closed.");
      // Stop was asked for while the fork was being made: no turn starts.
      if (side.turn?.stopped) throw new Error("The side chat was stopped.");
      const result = await this.host.rpc()!.call("turn/start", {
        threadId: side.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        model: c.model,
        effort:
          c.effort ??
          this.host
            .store()
            .projects.find((project) => project.id === c.projectId)
            ?.defaultEffort ??
          effortForMode(this.host.store().settings, c.mode),
      });
      if (side.turn && !cancelled()) {
        side.turn.turnId = result?.turn?.id;
        // Stop was asked for while the turn was starting.
        if (side.turn.stopped) void this.interruptTurn(side);
      }
    } catch (error) {
      if (!cancelled()) {
        side.turn = undefined;
        // A fork that was never made leaves nothing behind.
        if (!side.threadId) this.chats.delete(sideChatId);
      }
      throw error;
    }
    return answer.catch((error: Error) => {
      // The service's own words when it refused the request meanwhile.
      const refusal = this.host.lastRefusal();
      if (refusal && refusal.at >= startedAt && !cancelled())
        throw new Error(refusal.message);
      throw error;
    });
  }
  /**
   * Stop on a side chat's question: its turn is interrupted, and the answer
   * written so far (if any) is what the question resolves with. Quiet when
   * nothing is being answered.
   */
  async interrupt(id: string, sideChatId: string): Promise<void> {
    const side = this.chats.get(sideChatId);
    if (!side || side.conversationId !== id || !side.turn) return;
    side.turn.stopped = true;
    // Without a turn id the interrupt waits for turn/start to return one.
    if (side.turn.turnId) await this.interruptTurn(side);
  }
  /** Interrupts the side chat's running turn and cuts its request to the service. */
  private async interruptTurn(side: SideChat) {
    const threadId = side.threadId;
    const turnId = side.turn?.turnId;
    if (!threadId || !turnId) return;
    await this.host
      .rpc()
      ?.call("turn/interrupt", { threadId, turnId })
      .catch(() => {});
    this.host.gateway()?.abortThread(threadId);
  }
  /**
   * Lets a side chat go (Clear, or the conversation was left): a question
   * still being answered is stopped, and its fork is released.
   */
  end(id: string, sideChatId: string): void {
    const side = this.chats.get(sideChatId);
    if (!side || side.conversationId !== id) return;
    this.close(sideChatId, new Error("The side chat was closed."));
  }
  private open(sideChatId: string, conversationId: string) {
    // The oldest side chat that is not answering gives way to a new one.
    while (this.chats.size >= maxSideChats) {
      const oldest = [...this.chats].find(([, side]) => !side.turn);
      if (!oldest) throw new Error("Too many side chats are answering.");
      this.close(oldest[0], new Error("The side chat was closed."));
    }
    const side: SideChat = { conversationId };
    this.chats.set(sideChatId, side);
    return side;
  }
  /** The ephemeral fork a side chat asks its questions on. */
  private async fork(
    c: Conversation,
    provider: Provider,
    sideChatId: string,
    instructions: string,
  ) {
    const target = [...c.turns]
      .reverse()
      .find(
        (t) =>
          t.status !== "inProgress" &&
          !t.id.startsWith("pending-") &&
          !isOutboxTurn(t),
      );
    if (!c.threadId || !target)
      throw new Error(
        "Side chat is available once this session starts. Send your first message to start it.",
      );
    const project = this.host
      .store()
      .projects.find((p) => p.id === c.projectId);
    const options = this.host.threadOptions(
      c,
      provider,
      c.model,
      c.mode,
      project,
    );
    // A running thread is already loaded; loading it again would cut it off.
    if (!this.host.loaded(c.threadId)) await this.host.ensureThread(c, options);
    const fork = await this.host.rpc()!.call("thread/fork", {
      threadId: c.threadId,
      lastTurnId: target.id,
      ...reloadOptions({
        ...options,
        // Answers in words: nothing to read or write, nothing to ask about.
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
        developerInstructions: `${options.developerInstructions}\n\n${instructions}`,
      }),
    });
    const threadId: unknown = fork?.thread?.id;
    if (typeof threadId !== "string" || !threadId)
      throw new Error("The agent did not return a side chat thread.");
    this.threads.set(threadId, sideChatId);
    return threadId;
  }
  /** Applies a notification of a side chat's thread to the question it is answering. */
  notification(sideChatId: string, method: string, params: any) {
    const turn = this.chats.get(sideChatId)?.turn;
    if (!turn) return;
    const side = this.chats.get(sideChatId)!;
    if (method === "item/agentMessage/delta") {
      if (
        typeof params.itemId === "string" &&
        typeof params.delta === "string"
      ) {
        turn.messages.set(
          params.itemId,
          (turn.messages.get(params.itemId) ?? "") + params.delta,
        );
        this.emitText(side, sideChatId);
      }
    } else if (method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        turn.messages.set(item.id, item.text);
        this.emitText(side, sideChatId);
      }
    } else if (method === "turn/completed") {
      side.turn = undefined;
      const answer = sideAnswer(turn.messages);
      const status = params.turn?.status;
      if (status === "completed" && answer) turn.resolve(answer);
      // Stop keeps what was written (cutting the request can end the turn as failed).
      else if (turn.stopped && answer && status !== "completed")
        turn.resolve(answer);
      else if (status === "interrupted" || turn.stopped)
        turn.reject(new Error("The side chat was stopped."));
      else if (
        status === "failed" &&
        isLengthLimitError(params.turn?.error?.message)
      )
        turn.reject(new Error("The answer reached its maximum length."));
      else if (
        status === "failed" &&
        isContextLimitError(params.turn?.error?.message)
      )
        turn.reject(new Error(sideContextFull));
      else turn.reject(new Error("Couldn’t get an answer. Try again."));
    }
  }
  /** Sends the answer written so far to the window (not for a handoff note). */
  private emitText(side: SideChat, sideChatId: string) {
    const turn = side.turn;
    if (!turn?.stream) return;
    const text = sideAnswer(turn.messages);
    if (text && text !== turn.sent) {
      turn.sent = text;
      this.host.emit({
        type: "side-chat-text",
        conversationId: side.conversationId,
        sideChatId,
        text,
      });
    }
  }
  /** Ends one side chat: a running question is stopped and the fork released. */
  close(sideChatId: string, reason: Error) {
    const side = this.chats.get(sideChatId);
    if (!side) return;
    this.chats.delete(sideChatId);
    const running = side.turn;
    side.turn = undefined;
    const threadId = side.threadId;
    if (threadId) {
      this.threads.delete(threadId);
      const rpc = this.host.rpc();
      if (rpc) {
        if (running)
          void rpc
            .call("turn/interrupt", { threadId, turnId: running.turnId })
            .catch(() => {});
        void rpc.call("thread/unsubscribe", { threadId }).catch(() => {});
      }
      if (running) this.host.gateway()?.abortThread(threadId);
    }
    running?.reject(reason);
  }
  /** Ends every side chat (the agent stopped, so its forks are gone). */
  dropAll(reason: Error) {
    for (const sideChatId of [...this.chats.keys()])
      this.close(sideChatId, reason);
    this.threads.clear();
  }
}
