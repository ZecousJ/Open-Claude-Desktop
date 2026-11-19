import type { Conversation, Mode } from "./types";

export type CacheChangeKind = "model" | "effort" | "thinking";

/** Cowork cache-miss confirmation (live claude.ai bundle, 2026-10-14,
 * cca617cde-B64yBLGw.js and shared-5-DQt42NbL.js). */
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
