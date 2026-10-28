import type { AppEvent, Conversation } from "../../shared/types";
import type {
  CodeEmailEvent,
  CodeEmailStatus,
} from "../../shared/code-email-api";
import type { RoutineMailSession } from "../routines/routine-mail";
import { requestJson } from "../sub2api/http";

/** Each instance belongs to one signed-in runner context. No shared cache. */
export function codeMailer(
  session: () => RoutineMailSession | undefined,
  fetchImpl: typeof fetch = fetch,
) {
  async function request(method: "GET" | "POST", body?: CodeEmailEvent) {
    const owner = session();
    const base = owner?.baseUrl();
    if (!owner || !base) return undefined;
    return owner.authorized((token) =>
      requestJson(fetchImpl, `${base}/api/v1/claudex/code/email`, {
        method,
        token,
        ...(body ? { body } : {}),
      }),
    );
  }
  return {
    async status(): Promise<CodeEmailStatus> {
      const body = (await request("GET")) as CodeEmailStatus | undefined;
      return { available: body?.available === true };
    },
    async send(event: CodeEmailEvent) {
      const body = (await request("POST", event)) as
        { sent?: boolean } | undefined;
      return body?.sent === true;
    },
  };
}

/** Observe genuine runner events even when every browser tab is closed. */
export class CodeEmailDispatcher {
  private running = new Map<string, string>();
  private seen = new Set<string>();
  private approvals = new Set<string>();
  private stopped = false;

  constructor(
    private options: {
      enabled(): boolean;
      conversation(id: string): Conversation | undefined;
      /** Flush cloud settings and the owned conversation before service validation. */
      persist(): Promise<void>;
      send(event: CodeEmailEvent): Promise<boolean>;
      failed(error: unknown): void;
    },
  ) {}

  observe(event: AppEvent) {
    if (this.stopped) return;
    if (event.type === "conversation") {
      const conversation = event.conversation;
      const turn = conversation.turns.at(-1);
      if (!emailConversationEligible(conversation) || !turn) {
        this.running.delete(conversation.id);
        return;
      }
      const previous = this.running.get(conversation.id);
      if (turn.status === "inProgress") {
        this.running.set(conversation.id, turn.id);
      } else {
        this.running.delete(conversation.id);
        if (
          previous === turn.id &&
          (turn.status === "completed" || turn.status === "failed")
        )
          this.deliver({
            conversationId: conversation.id,
            eventId: `turn:${turn.id}`,
            outcome: turn.status,
          });
      }
    } else if (event.type === "approval" && !event.reAlert) {
      this.approvals.add(`approval:${event.approval.id}`);
      this.deliver({
        conversationId: event.approval.conversationId,
        eventId: `approval:${event.approval.id}`,
        outcome: "needs_attention",
      });
    } else if (event.type === "approval-resolved") {
      this.approvals.delete(`approval:${event.id}`);
    }
  }

  private deliver(event: CodeEmailEvent) {
    const conversation = this.options.conversation(event.conversationId);
    if (!this.options.enabled() || !emailConversationEligible(conversation))
      return;
    const key = `${event.conversationId}:${event.eventId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    // A bounded per-context history also avoids leaking deleted session names.
    if (this.seen.size > 2048)
      this.seen.delete(this.seen.values().next().value!);
    void (async () => {
      await this.options.persist();
      const current = this.options.conversation(event.conversationId);
      if (
        this.stopped ||
        !this.options.enabled() ||
        !emailConversationEligible(current) ||
        (event.outcome === "needs_attention" &&
          !this.approvals.has(event.eventId))
      )
        return;
      await this.options.send(event);
    })().catch((error) => {
      if (!this.stopped) this.options.failed(error);
    });
  }

  stop() {
    this.stopped = true;
    this.running.clear();
    this.seen.clear();
    this.approvals.clear();
  }
}

function emailConversationEligible(conversation: Conversation | undefined) {
  return (
    !!conversation &&
    conversation.mode === "code" &&
    !conversation.archived &&
    !conversation.incognito &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    conversation.environment?.kind !== "ssh"
  );
}
