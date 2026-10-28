import type { Conversation } from "../../shared/types";

/**
 * Chats marked unread by hand in this window: the open one keeps that mark
 * until the next visit. Any other unread mark on the chat on screen came from
 * another window or device (it finished there unseen) and is read at once.
 */
export const markedUnreadByHand = new Set<string>();

export const isRunning = (c?: Conversation) =>
  c?.turns.some((t) => t.status === "inProgress") ?? false;

/**
 * Whether an update means a reply finished while its chat was not on screen, so
 * the row should show as unread. Incognito chats and chats that are already
 * unread are left alone.
 */
export function finishedUnseen(
  previous: Conversation | undefined,
  next: Conversation,
  visible: boolean,
) {
  return (
    !visible &&
    !next.incognito &&
    !next.unread &&
    isRunning(previous) &&
    !isRunning(next)
  );
}

/** Something in the sidebar wants attention: an unread chat or a waiting request. */
export const needsAttention = (
  conversations: Conversation[],
  approvalIds: ReadonlySet<string>,
) =>
  conversations.some(
    (c) => !c.incognito && !c.archived && (c.unread || approvalIds.has(c.id)),
  );
