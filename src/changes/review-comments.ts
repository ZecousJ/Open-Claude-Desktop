import { useSyncExternalStore } from "react";

/**
 * Comments on the Changes panel's lines that go to Claude with the next
 * message.
 */
export interface ReviewComment {
  id: string;
  file: string;
  /** First and last line (new file's numbers; old file's for removed lines). */
  startLine: number;
  endLine: number;
  /** The lines commented on, as shown. */
  code: string;
  text: string;
}

const byConversation = new Map<string, ReviewComment[]>();
const listeners = new Set<() => void>();
const empty: ReviewComment[] = [];
const emit = () => listeners.forEach((listener) => listener());

export function reviewComments(conversationId: string | undefined) {
  return (conversationId && byConversation.get(conversationId)) || empty;
}

export function addReviewComment(
  conversationId: string,
  comment: Omit<ReviewComment, "id">,
) {
  const list = reviewComments(conversationId);
  byConversation.set(conversationId, [
    ...list,
    { ...comment, id: `${Date.now()}-${list.length}` },
  ]);
  emit();
}

export function removeReviewComment(conversationId: string, id: string) {
  byConversation.set(
    conversationId,
    reviewComments(conversationId).filter((comment) => comment.id !== id),
  );
  emit();
}

export function clearReviewComments(conversationId: string) {
  if (!byConversation.delete(conversationId)) return;
  emit();
}

export function useReviewComments(conversationId: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => reviewComments(conversationId),
  );
}

/** "app.js:12" or "app.js:12–14". */
export function commentWhere(comment: ReviewComment) {
  return comment.startLine === comment.endLine
    ? `${comment.file}:${comment.startLine}`
    : `${comment.file}:${comment.startLine}–${comment.endLine}`;
}

/** What Claude reads: each comment with the lines it is about, then the message. */
export function withReviewComments(prompt: string, comments: ReviewComment[]) {
  if (!comments.length) return prompt;
  const blocks = comments.map(
    (comment) =>
      `Review comment on ${commentWhere(comment)}:\n\`\`\`\n${comment.code}\n\`\`\`\n${comment.text}`,
  );
  return [...blocks, prompt.trim() || "Address these review comments."]
    .filter(Boolean)
    .join("\n\n");
}
