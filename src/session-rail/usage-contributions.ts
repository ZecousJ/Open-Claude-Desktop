import type { Conversation } from "../../shared/types";
import { workflowsIn } from "../../shared/workflow-model";

/**
 * What's contributing (this session): what the session can attribute itself, by
 * category. Claudex knows each subagent's tokens and each MCP server's calls;
 * skills and plugins are not told apart from the session's own requests.
 */
export interface Contribution {
  category: "Subagent" | "MCP";
  name: string;
  /** Tokens for a subagent, calls for an MCP server. */
  amount: number;
  unit: "tokens" | "calls";
}

export function sessionContributions(
  conversation: Conversation,
): Contribution[] {
  const out: Contribution[] = [];
  for (const task of workflowsIn([conversation]))
    for (const agent of task.agents)
      if ((agent.tokens ?? 0) > 0)
        out.push({
          category: "Subagent",
          name: agent.name,
          amount: agent.tokens!,
          unit: "tokens",
        });
  const calls = new Map<string, number>();
  for (const turn of conversation.turns)
    for (const item of turn.items)
      if (item.type === "mcpToolCall" && typeof item.server === "string")
        calls.set(item.server, (calls.get(item.server) ?? 0) + 1);
  for (const [server, count] of calls)
    out.push({ category: "MCP", name: server, amount: count, unit: "calls" });
  return out.sort((a, b) =>
    a.category === b.category
      ? b.amount - a.amount
      : a.category === "Subagent"
        ? -1
        : 1,
  );
}
