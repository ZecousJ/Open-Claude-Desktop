import type { Conversation, Mode } from "./types";

export type CacheChangeKind = "model" | "effort" | "thinking";

/** Cowork cache-miss confirmation. */
export function needsCacheConfirmation(
  mode: Mode,
  conversation?: Conversation,
) {
  return (
    mode === "cowork" &&
    conversation?.mode === "cowork" &&
    conversation.turns.some(
      (turn) => turn.status === "inProgress" || turn.items.length > 0,
    )
  );
}
