import type { Conversation, Mode, Turn } from "../../shared/types";

/**
 * Which of Edit and Restart a Cowork prompt shows. The original's message row
 * offers Edit on the conversation's last prompt only, and only while no reply
 * is being written; "Restart session from here" sits on a prompt on the same
 * terms. Neither is there for a prompt that is not a message to Claude (a
 * /compact turn, a Bash line or a review has nothing to send again). Code has
 * no such row: its prompts go back with Rewind to here in the right-click menu.
 */
export function coworkPromptActions(
  conversation: Pick<Conversation, "turns">,
  turn: Turn,
  mode: Mode,
  busy: boolean,
) {
  const none = { edit: false, restart: false };
  if (mode !== "cowork" || busy) return none;
  if (conversation.turns.at(-1)?.id !== turn.id) return none;
  if (turn.status === "inProgress") return none;
  if (turn.compaction || turn.shell || turn.review) return none;
  return { edit: true, restart: true };
}

/** What saving an edited Cowork prompt does. */
export const coworkEditNote =
  "Saving sends this as your latest message and restarts from here.";
