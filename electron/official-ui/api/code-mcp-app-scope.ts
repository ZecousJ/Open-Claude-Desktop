import type { Conversation, Item, Turn } from "../../../shared/types";

export function codeMcpAppAllowsTool(
  conversation: Conversation | undefined,
  toolUseId: string,
  serverName: string,
  toolName: string,
) {
  const tools = conversation?.connectorToolOverrides?.[serverName];
  if (
    conversation?.mode !== "code" ||
    conversation.connectorOverrides?.[serverName] === false ||
    tools?.[toolName] === false
  )
    return false;
  const matchesOrigin = (turn: Turn, item: Item) => {
    const uri: unknown = item.appContext?.resourceUri ?? item.mcpAppResourceUri;
    return (
      `${turn.id}:tool:${item.id}` === toolUseId &&
      item.type === "mcpToolCall" &&
      item.server === serverName &&
      typeof item.tool === "string" &&
      typeof uri === "string" &&
      uri.startsWith("ui://") &&
      tools?.[item.tool] !== false
    );
  };
  const hasOrigin = (turns: readonly Turn[]): boolean =>
    turns.some((turn) =>
      turn.items.some((item) =>
        matchesOrigin(turn, item) ||
        Object.values(item.agentThreads ?? {}).some((child) => hasOrigin(child.turns)),
      ),
    );
  return hasOrigin(conversation.turns) ||
    (conversation.savedBranches ?? []).some((branch) => hasOrigin(branch.turns));
}
