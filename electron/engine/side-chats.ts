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
  maxSideStartEvents,
  maxSideStartEventBytes,
  sideAnswer,
  sideContextFull,
  type SideChat,
} from "./side-chat-model";
import { reloadOptions, type ThreadOptions } from "./thread-options";

interface SideOwner {
  store: Store;
  conversation: Conversation;
  rpc: CodexRPC;
  gateway: ProviderServiceClient | undefined;
}
type OwnedSideChat = SideChat & { owner?: SideOwner; sidePath?: string };
type SideTurn = NonNullable<SideChat["turn"]>;

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
  mcpServerNames(): string[];
  threadOptions(
    c: Conversation,
    provider: Provider,
    model: string,
    mode: Mode,
    project?: Project,
  ): ThreadOptions;
  loaded(threadId: string): boolean;
  ensureThread(
    c: Conversation,
    options: ThreadOptions,
    current?: () => boolean,
  ): Promise<unknown>;
}

/**
 * Side chats (askSideChat) and the handoff note: questions answered on an
 * ephemeral fork of the conversation's thread, by id, with their threads'
 * ids back to them. Their thread notifications come here, not to the
 * conversation.
 */
export class SideChats {
  private chats = new Map<string, OwnedSideChat>();
  private threads = new Map<string, { id: string; side: OwnedSideChat }>();
  constructor(private host: SideChatHost) {}

  /** The side chat a thread belongs to, if it is one. */
  chatOfThread(threadId: unknown) {
    const entry =
      typeof threadId === "string" ? this.threads.get(threadId) : undefined;
    return entry && this.chats.get(entry.id) === entry.side
      ? entry.id
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
    const store = this.host.store();
    const c = store.conversation(id);
    const existing = this.chats.get(sideChatId);
    if (existing && existing.conversationId !== id)
      throw new Error("This side chat belongs to another conversation.");
    if (existing?.turn) throw new Error("The side chat is still answering.");
    const provider = store.settings.providers.find(
      (p) => p.id === c.providerId,
    );
    if (!provider) throw new Error("The model service is unavailable.");
    this.host.assertModel(provider, c.model);
    if (this.host.policy().update?.state === "required")
      throw new Error(updateRefusal(this.host.policy().update!));
    const side = existing ?? this.open(sideChatId, id);
    const startedAt = Date.now();
    // Registered before anything is awaited: the next question sees this one running.
    let turn!: SideTurn;
    const answer = new Promise<string>((resolve, reject) => {
      side.turn = turn = {
        messages: new Map(),
        stream,
        resolve,
        reject,
        startEvents: [],
        startEventBytes: 0,
      };
    });
    answer.catch(() => {});
    const cancelled = () => this.chats.get(sideChatId) !== side;
    const check = () => {
      if (cancelled() || side.turn !== turn)
        throw turn.closedReason ?? new Error("The side chat was closed.");
      if (
        this.host.store() !== store ||
        store.conversation(id) !== c ||
        (side.owner && !this.ownerCurrent(side.owner))
      )
        throw new Error("The side chat's account or agent changed.");
    };
    void (async () => {
      try {
        await this.host.ensure(provider);
        check();
        const rpc = this.host.rpc();
        if (!rpc) throw new Error("The Codex engine is not connected.");
        const owner = (side.owner ??= {
          store,
          conversation: c,
          rpc,
          gateway: this.host.gateway(),
        });
        if (!side.threadId) {
          const threadId = await this.fork(
            c,
            provider,
            instructions,
            owner,
            side,
            () =>
              this.chats.get(sideChatId) === side &&
              side.turn === turn &&
              this.ownerCurrent(owner),
          );
          try {
            check();
          } catch (error) {
            this.releaseThread(side, threadId);
            throw error;
          }
          side.threadId = threadId;
          this.threads.set(threadId, { id: sideChatId, side });
        }
        check();
        // Stop was asked for while the fork was being made: no turn starts.
        if (turn.stopped) throw new Error("The side chat was stopped.");
        const threadId = side.threadId;
        turn.startPending = true;
        turn.startAttempted = true;
        let result: any;
        try {
          result = await owner.rpc.call("turn/start", {
            threadId,
            input: [{ type: "text", text, text_elements: [] }],
            environments: [],
            model: c.model,
            effort:
              c.effort ??
              this.host
                .store()
                .projects.find((project) => project.id === c.projectId)
                ?.defaultEffort ??
              effortForMode(this.host.store().settings, c.mode),
          });
        } finally {
          turn.startPending = false;
        }
        const turnId: unknown = result?.turn?.id;
        if (typeof turnId !== "string" || !turnId.trim())
          throw new Error("The agent did not return a side chat turn.");
        turn.turnId = turnId;
        check();
        const early = turn.startEvents;
        turn.startEvents = [];
        turn.startEventBytes = 0;
        for (const event of early)
          this.notification(sideChatId, event.method, event.params);
        // Stop may have arrived while turn/start was pending. A terminal early
        // event already settled it; otherwise interrupt exactly this turn.
        if (side.turn === turn && turn.stopped)
          void this.interruptTurn(side, turn);
      } catch (error) {
        // An uncertain start must never leave an implicitly reusable fork.
        if (!cancelled() && side.turn === turn) {
          if (
            turn.stopped &&
            !turn.startAttempted &&
            side.owner &&
            this.ownerCurrent(side.owner)
          ) {
            side.turn = undefined;
            turn.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          } else
            this.close(
              sideChatId,
              error instanceof Error ? error : new Error(String(error)),
            );
        } else if (side.threadId && !turn.startPending)
          this.releaseThread(side, side.threadId, turn.turnId);
        turn.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    return answer.catch((error: Error) => {
      // The service's own words when it refused the request meanwhile.
      const refusal = this.host.lastRefusal();
      if (refusal && refusal.at >= startedAt && !cancelled())
        throw new Error(refusal.message);
      throw error;
    });
  }
  private ownerCurrent(owner: SideOwner) {
    try {
      return (
        this.host.store() === owner.store &&
        this.host.rpc() === owner.rpc &&
        this.host.gateway() === owner.gateway &&
        owner.store.conversation(owner.conversation.id) === owner.conversation
      );
    } catch {
      return false;
    }
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
    if (side.turn.turnId) await this.interruptTurn(side, side.turn);
  }
  /** Interrupts the side chat's running turn and cuts its request to the service. */
  private async interruptTurn(side: OwnedSideChat, turn: SideTurn) {
    const threadId = side.threadId;
    const turnId = turn.turnId;
    const owner = side.owner;
    if (!threadId || !turnId || !owner || side.turn !== turn) return;
    // Abort before awaiting: a late interrupt response cannot abort a newer turn.
    owner.gateway?.abortThread(threadId);
    await owner.rpc
      .call("turn/interrupt", { threadId, turnId })
      .catch(() => {});
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
    const side: OwnedSideChat = { conversationId };
    this.chats.set(sideChatId, side);
    return side;
  }
  /** The ephemeral fork a side chat asks its questions on. */
  private async fork(
    c: Conversation,
    provider: Provider,
    instructions: string,
    owner: SideOwner,
    side: OwnedSideChat,
    current: () => boolean,
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
    if (!this.host.loaded(c.threadId))
      await this.host.ensureThread(c, options, current);
    if (!current())
      throw new Error("The side chat's account or agent changed.");
    if (!owner.gateway) throw new Error("The side question gateway is unavailable.");
    const sidePath = await owner.gateway.openSidePath();
    let retained = false;
    try {
      if (!current()) throw new Error("The side chat's account or agent changed.");
      const effective = await owner.rpc.call("config/read", { includeLayers: false });
      if (!current()) throw new Error("The side chat's account or agent changed.");
      let base: URL;
      try {
        base = new URL(effective?.config?.model_providers?.claudex?.base_url);
      } catch {
        throw new Error("The side question gateway address is unavailable.");
      }
      if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
          base.username || base.password || base.search || base.hash || !/^\/v1\/?$/.test(base.pathname))
        throw new Error("The side question gateway address is unavailable.");
      base.pathname = `/v1/side/${sidePath}`;
      const fork = await owner.rpc.call("thread/fork", {
        threadId: c.threadId,
        lastTurnId: target.id,
        ...reloadOptions({
          ...options,
          config: {
            ...options.config,
            "model_providers.claudex.base_url": base.toString().replace(/\/$/, ""),
            ...Object.fromEntries(
              [
                ...this.host.mcpServerNames(),
                ...Object.keys(options.config).flatMap((key) => {
                  const match = /^mcp_servers\.([^.]+)\./.exec(key);
                  return match ? [match[1]] : [];
                }),
              ].map((name) => [`mcp_servers.${name}.enabled`, false]),
            ),
            web_search: "disabled",
            "features.multi_agent": false,
            "features.multi_agent_v2": false,
          },
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
      side.sidePath = sidePath;
      retained = true;
      return threadId;
    } finally {
      if (!retained) void owner.gateway.closeSidePath(sidePath).catch(() => {});
    }
  }
  /** Applies a notification of a side chat's thread to the question it is answering. */
  notification(sideChatId: string, method: string, params: any) {
    const side = this.chats.get(sideChatId);
    const turn = side?.turn;
    if (!turn) return;
    if (!side?.owner || !this.ownerCurrent(side.owner)) {
      this.close(
        sideChatId,
        new Error("The side chat's account or agent changed."),
      );
      return;
    }
    if (params?.threadId !== side.threadId) return;
    if (
      !["item/agentMessage/delta", "item/completed", "turn/completed"].includes(
        method,
      )
    )
      return;
    const eventTurnId =
      method === "turn/completed" ? params.turn?.id : params.turnId;
    if (typeof eventTurnId !== "string" || !eventTurnId.trim()) return;
    if (turn.startPending) {
      let encoded: string;
      try {
        encoded = JSON.stringify({ method, params });
      } catch {
        this.close(sideChatId, new Error("Invalid side chat event."));
        return;
      }
      const bytes = Buffer.byteLength(encoded, "utf8");
      if (
        turn.startEvents.length >= maxSideStartEvents ||
        bytes > maxSideStartEventBytes - turn.startEventBytes
      ) {
        this.close(
          sideChatId,
          new Error(
            "Too much side chat output arrived before the turn started.",
          ),
        );
        return;
      }
      turn.startEvents.push(JSON.parse(encoded));
      turn.startEventBytes += bytes;
      return;
    }
    if (!turn.turnId || eventTurnId !== turn.turnId) return;
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
      if (
        item?.type === "agentMessage" &&
        typeof item.id === "string" &&
        item.id.trim() &&
        typeof item.text === "string"
      ) {
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
    if (running) {
      running.closedReason = reason;
      running.startEvents = [];
      running.startEventBytes = 0;
    }
    const threadId = side.threadId;
    if (threadId) {
      if (this.threads.get(threadId)?.side === side)
        this.threads.delete(threadId);
      if (running?.startPending && !running.turnId)
        side.owner?.gateway?.abortThread(threadId); // Release when its pending start settles.
      else this.releaseThread(side, threadId, running?.turnId);
    }
    running?.reject(reason);
  }
  /** Clean up only resources created by this captured side, never a replacement. */
  private releaseThread(
    side: OwnedSideChat,
    threadId: string,
    turnId?: string,
  ) {
    const owner = side.owner;
    if (!owner) return;
    const replacement = this.threads.get(threadId);
    const sidePath = side.sidePath;
    side.sidePath = undefined;
    if (replacement && replacement.side !== side) {
      if (sidePath) void owner.gateway?.closeSidePath(sidePath).catch(() => {});
      return;
    }
    if (replacement) this.threads.delete(threadId);
    owner.gateway?.abortThread(threadId);
    if (sidePath) void owner.gateway?.closeSidePath(sidePath).catch(() => {});
    void (async () => {
      if (turnId)
        await owner.rpc
          .call("turn/interrupt", { threadId, turnId })
          .catch(() => {});
      await owner.rpc.call("thread/unsubscribe", { threadId }).catch(() => {});
    })();
  }
  /** Ends every side chat (the agent stopped, so its forks are gone). */
  dropAll(reason: Error) {
    for (const sideChatId of [...this.chats.keys()])
      this.close(sideChatId, reason);
    this.threads.clear();
  }
}
