import {
  artifactNoteLimits,
  type ArtifactComment,
} from "../../shared/artifact-notes";

/*
 * A comment and its replies as one thread, after the original's comment cards:
 * the first comment can be edited, resolved and reopened, and the whole thread
 * deleted; a reply can be edited and deleted; a reply to a resolved thread
 * reopens it ("Reply to reopen…"). Every change answers the comments list to
 * save, so the order and the other comments stay as they were.
 */

/** The text a comment or reply may hold, trimmed; undefined when it is empty or too long. */
export function threadText(text: string) {
  const value = text.trim();
  return value && value.length <= artifactNoteLimits.commentChars
    ? value
    : undefined;
}

function change(
  comments: ArtifactComment[],
  id: string,
  update: (comment: ArtifactComment) => ArtifactComment,
) {
  return comments.map((comment) =>
    comment.id === id ? update(comment) : comment,
  );
}

export function toggleResolved(comments: ArtifactComment[], id: string) {
  return change(comments, id, (comment) => ({
    ...comment,
    resolved: !comment.resolved,
  }));
}

/** The comment's own text, marked edited; an unchanged or empty text changes nothing. */
export function editComment(
  comments: ArtifactComment[],
  id: string,
  text: string,
  now: number,
) {
  const value = threadText(text);
  return change(comments, id, (comment) =>
    !value || value === comment.text
      ? comment
      : { ...comment, text: value, editedAt: now },
  );
}

/** The whole thread: the comment, its pin and its replies. */
export function deleteThread(comments: ArtifactComment[], id: string) {
  return comments.filter((comment) => comment.id !== id);
}

/**
 * Adds a reply to the thread, and reopens it when it was resolved. At the
 * reply limit, or with nothing to say, the comments come back unchanged.
 */
export function addReply(
  comments: ArtifactComment[],
  id: string,
  text: string,
  reply: { id: string; now: number },
) {
  const value = threadText(text);
  return change(comments, id, (comment) =>
    !value || (comment.replies?.length ?? 0) >= artifactNoteLimits.replies
      ? comment
      : {
          ...comment,
          resolved: false,
          replies: [
            ...(comment.replies ?? []),
            { id: reply.id, text: value, createdAt: reply.now },
          ],
        },
  );
}

export function editReply(
  comments: ArtifactComment[],
  id: string,
  replyId: string,
  text: string,
  now: number,
) {
  const value = threadText(text);
  return change(comments, id, (comment) => ({
    ...comment,
    replies: comment.replies?.map((reply) =>
      reply.id !== replyId || !value || value === reply.text
        ? reply
        : { ...reply, text: value, editedAt: now },
    ),
  }));
}

export function deleteReply(
  comments: ArtifactComment[],
  id: string,
  replyId: string,
) {
  return change(comments, id, (comment) => ({
    ...comment,
    replies: comment.replies?.filter((reply) => reply.id !== replyId),
  }));
}

/** How many threads are still open: the comment button's count. */
export function openCommentCount(comments: ArtifactComment[]) {
  return comments.filter((comment) => !comment.resolved).length;
}
