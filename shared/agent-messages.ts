import type { Conversation, Item } from "./types";
import { agentThreadIds } from "./workflow-usage";

export interface AgentMessageOrigin {
  kind: "peer";
  name?: string;
  subagent?: boolean;
  handback?: boolean;
  relayedAgent?: { name?: string };
}

/** Peer attribution. */
export function agentMessageOrigin(item: Item): AgentMessageOrigin | undefined {
  const origin = item.origin;
  if (origin?.kind !== "peer") return;
  return {
    kind: "peer",
    name:
      typeof origin.name === "string" ? origin.name.slice(0, 500) : undefined,
    subagent: origin.subagent === true,
    handback: origin.handback === true,
    ...(origin.relayedAgent && typeof origin.relayedAgent === "object"
      ? {
          relayedAgent: {
            name:
              typeof origin.relayedAgent.name === "string"
                ? origin.relayedAgent.name.slice(0, 500)
                : undefined,
          },
        }
      : {}),
  };
}

export function agentMessageTitle(origin: AgentMessageOrigin) {
  return origin.name !== undefined
    ? "Message from {name}"
    : origin.handback
      ? "Report from subagent"
      : origin.subagent
        ? "Message from subagent"
        : "Message from another session";
}

export function peerMessage(item: Item): Item | undefined {
  if (agentMessageOrigin(item))
    return { ...item, type: "peerMessage", origin: agentMessageOrigin(item) };
  if (item.type !== "userMessage") return;
  const text =
    item.text ??
    (Array.isArray(item.content)
      ? item.content
          .filter(
            (part) => part?.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
      : "");
  const match =
    /^\s*<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>\s*$/.exec(
      text,
    );
  if (!match) return;
  try {
    const notification = JSON.parse(match[1]);
    if (
      typeof notification.agent_id !== "string" ||
      !notification.status ||
      typeof notification.status !== "object"
    )
      return;
    const report = notification.status.completed ?? notification.status.errored;
    if (typeof report !== "string") return;
    return {
      id: item.id,
      type: "peerMessage",
      text: report,
      agentThreadId: notification.agent_id,
      origin: {
        kind: "peer",
        subagent: true,
        handback: true,
      } satisfies AgentMessageOrigin,
    };
  } catch {
    return;
  }
}

export function recordAgentsStopped(conversation: Conversation) {
  const states = new Map<string, string>();
  for (const turn of conversation.turns)
    for (const item of turn.items)
      for (const id of agentThreadIds(item))
        states.set(
          id,
          item.agentsStates?.[id]?.status ??
            (item.kind === "interrupted" ? "interrupted" : "running"),
        );
  if (
    !states.size ||
    [...states.values()].some(
      (status) =>
        ![
          "completed",
          "interrupted",
          "shutdown",
          "errored",
          "notFound",
          "failed",
        ].includes(status),
    )
  )
    return;
  const turn = conversation.turns.at(-1);
  if (!turn || turn.items.at(-1)?.notice === "agents_killed") return;
  turn.items.push({
    id: `agents-stopped-${turn.id}-${turn.items.length}`,
    type: "agentNotice",
    notice: "agents_killed",
  });
}
