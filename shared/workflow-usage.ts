import type { Conversation, Item } from "./types";
/** Child agent thread IDs that a native collaboration or sub-agent item refers to. */
export function agentThreadIds(item: Item): string[] {
  if (item.type === "subAgentActivity")
    return typeof item.agentThreadId === "string" ? [item.agentThreadId] : [];
  if (
    item.type === "collabAgentToolCall" &&
    Array.isArray(item.receiverThreadIds)
  )
    return item.receiverThreadIds.filter(
      (id): id is string => typeof id === "string",
    );
  return [];
}
export function ownsWorkflowAgent(item: Item, agentId: string): boolean {
  return agentThreadIds(item).includes(agentId);
}
/** A child token counter is cumulative; never add repeat notifications twice. */
export function applyAgentUsage(
  conversation: Conversation,
  agentId: string,
  totalTokens: number,
): boolean {
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return false;
  let changed = false;
  for (const turn of conversation.turns)
    for (const item of turn.items) {
      if (!ownsWorkflowAgent(item, agentId)) continue;
      const previous = item.agentTokenUsage?.[agentId];
      if (typeof previous === "number" && previous >= totalTokens) continue;
      item.agentTokenUsage = {
        ...item.agentTokenUsage,
        [agentId]: totalTokens,
      };
      changed = true;
    }
  return changed;
}
