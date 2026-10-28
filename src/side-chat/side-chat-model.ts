import type { Conversation, Mode } from "../../shared/types";
import { formatText } from "../i18n";

/** Whether a conversation can have a side chat, and why not when it cannot. */
export interface SideChatAvailability {
  available: boolean;
  reason?: string;
}

/**
 * Where a side chat can be started. Chat and Code have it; a Cowork task does
 * not.
 */
export function sideChatAvailability(
  conversation: Pick<Conversation, "mode" | "threadId" | "turns"> | undefined,
  mode: Mode,
): SideChatAvailability {
  if (mode === "cowork" || conversation?.mode === "cowork")
    return {
      available: false,
      reason: "Side chat isn’t available in Cowork tasks.",
    };
  if (!conversation)
    return {
      available: false,
      reason:
        mode === "code"
          ? "Open a session to use side chat"
          : "Open a chat to use side chat",
    };
  // The side chat forks the thread at its last finished turn.
  const finished = conversation.turns.some(
    (turn) => turn.status !== "inProgress" && !turn.id.startsWith("pending-"),
  );
  if (!conversation.threadId || !finished)
    return {
      available: false,
      reason:
        "Side chat is available once this conversation starts. Send your first message to start it.",
    };
  return { available: true };
}

/**
 * How many messages of the main chat the side chat sees: each prompt, and
 * each reply that has text (the original's "Sees N messages from main chat").
 */
export function inheritedMessageCount(
  conversation: Pick<Conversation, "turns">,
): number {
  let count = 0;
  for (const turn of conversation.turns) {
    if (turn.id.startsWith("pending-")) continue;
    count++;
    if (turn.items.some((item) => item.type === "agentMessage" && item.text))
      count++;
  }
  return count;
}

/**
 * What "Branch to new chat" puts in the new conversation's composer: the side
 * question and its answer, to carry on from.
 */
export function branchDraft(question: string | undefined, answer: string) {
  return question === undefined
    ? answer
    : formatText(
        "Continuing from a side question.\n\nQ: {question}\n\nA: “{answer}”\n\n",
        { question, answer },
      );
}
