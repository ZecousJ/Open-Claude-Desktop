import type { AgentPromptEvent } from "../../server/agent-prompt-observer";
import { agentThreadIds, ownsWorkflowAgent } from "../../shared/workflow-usage";
import type {
  Conversation,
  EnvironmentRef,
  Item,
  Turn,
} from "../../shared/types";
import { type GatewaySignalContext, type ItemPatch } from "./engine-extensions";
import { applyItemPatch } from "./item-patches";
import { sameEnvironment } from "./engine-types";
import { pendingPromptKey } from "./turn-items";
import { maxPendingAgentPrompts } from "./engine-support";
import type { Engine } from "./engine";

/**
 * The engine that runs a conversation, when it isn't this one. Throws
 * when no engine of the account can run it.
 */
export function elsewhere(
  this: Engine,
  target: Pick<Conversation, "environment"> | EnvironmentRef | undefined,
): Engine | undefined {
  const environment =
    target && "kind" in target
      ? target
      : ((target as Pick<Conversation, "environment"> | undefined)
          ?.environment ?? { kind: "local" as const });
  if (sameEnvironment(environment, this.environment)) return undefined;
  const peer = this.peers?.forEnvironment(environment);
  if (!peer || peer === this)
    throw new Error(
      environment.kind === "ssh"
        ? "This conversation runs on an SSH host that isn't available."
        : "This conversation runs on this computer.",
    );
  return peer;
}

/** The engine of a stored conversation, when it isn't this one. */
export function elsewhereFor(this: Engine, conversationId: string) {
  return this.elsewhere(this.store.conversation(conversationId));
}

/** Rebuilds the child thread → parent conversation index from stored items. */
export function indexAgentRoutes(this: Engine) {
  this.agentRoutes.clear();
  for (const conversation of this.store.conversations)
    if (this.owns(conversation))
      for (const turn of conversation.turns)
        for (const item of turn.items)
          for (const agentId of agentThreadIds(item))
            this.agentRoutes.set(agentId, conversation.id);
}

/** The conversation that spawned a child thread, if it still records that child. */
export function parentForAgent(
  this: Engine,
  id: string,
): Conversation | undefined {
  const ownerOf = (conversationId: string | undefined) =>
    this.store.conversations.find(
      (conversation) =>
        conversation.id === conversationId &&
        conversation.turns.some((turn) =>
          turn.items.some((item) => ownsWorkflowAgent(item, id)),
        ),
    );
  const known = ownerOf(this.agentRoutes.get(id));
  if (known) return known;
  // The index may predate the item that introduced this child; rebuild once.
  this.indexAgentRoutes();
  return ownerOf(this.agentRoutes.get(id));
}

export function captureAgentPrompt(
  this: Engine,
  { parentThreadId, callId, message, model }: AgentPromptEvent,
) {
  const conversationId = this.routes.get(parentThreadId);
  const parent = conversationId
    ? this.store.conversations.find(
        (value) =>
          value.id === conversationId && value.threadId === parentThreadId,
      )
    : undefined;
  if (!parent) return;
  const item = parent.turns
    .flatMap((turn) => turn.items)
    .find((value) => value.id === callId && value.type === "subAgentActivity");
  if (item) {
    item.agentPrompt = message;
    if (model) item.agentModel = model;
    this.changed(parent);
    return;
  }
  // The prompt can arrive before the child's item; hold a bounded number until it does.
  if (this.pendingAgentPrompts.size >= maxPendingAgentPrompts)
    this.pendingAgentPrompts.delete(
      this.pendingAgentPrompts.keys().next().value!,
    );
  this.pendingAgentPrompts.set(pendingPromptKey(parentThreadId, callId), {
    message,
    model,
  });
}

export function attachPendingPrompt(
  this: Engine,
  parentThreadId: string,
  item: Item,
) {
  const key = pendingPromptKey(parentThreadId, item.id);
  const prompt = this.pendingAgentPrompts.get(key);
  if (!prompt) return;
  item.agentPrompt = prompt.message;
  if (prompt.model) item.agentModel = prompt.model;
  this.pendingAgentPrompts.delete(key);
}

/**
 * The conversation a gateway signal concerns: the one whose current
 * thread made the request, or (only when an extension listens) the one
 * that started the child agent owning that thread.
 */
export function signalTarget(
  this: Engine,
  threadId: string,
): GatewaySignalContext {
  const conversationId = this.routes.get(threadId);
  const conversation = conversationId
    ? this.store.conversations.find(
        (value) => value.id === conversationId && value.threadId === threadId,
      )
    : undefined;
  if (conversation) return { conversation };
  if (!this.extensions.list().some((entry) => entry.onGatewaySignal)) return {};
  return { parent: this.parentForAgent(threadId) };
}

/**
 * Sets fields on one of a conversation's items, or holds them until Codex
 * reports the item (bounded). Returns the turn holding the item.
 */
export function patchItem(
  this: Engine,
  c: Conversation,
  threadId: string,
  itemId: string,
  patch: ItemPatch,
): Turn | undefined {
  for (const turn of c.turns) {
    const item = turn.items.find((value) => value.id === itemId);
    if (!item) continue;
    if (applyItemPatch(item, patch)) {
      this.changed(c);
      return turn;
    }
    // A message still streaming may match once its text is complete.
    if (
      patch.types.includes(item.type) &&
      patch.accepts &&
      item.lifecycleStatus === "inProgress"
    )
      this.pendingPatches.hold(threadId, itemId, patch);
    return turn;
  }
  this.pendingPatches.hold(threadId, itemId, patch);
  return undefined;
}
