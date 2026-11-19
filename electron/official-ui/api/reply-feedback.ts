import type { AdapterContext } from "./context";
import { assistantMessageId, messageRef, resolveConversationId } from "./conversations";
import { completedReply } from "../../../shared/branches";

type FeedbackRefusal = { code: string; message: string };
const refusal = (code: string, message: string): FeedbackRefusal => ({ code, message });
const FEEDBACK_UNSPECIFIED = 0, FEEDBACK_UPVOTE = 1, FEEDBACK_DOWNVOTE = 2;

export async function applyReplyFeedback(
  ctx: AdapterContext,
  pageConversationId: string,
  input: { messageId: string; type: number; comment?: string },
  feedbackTypes: ReadonlySet<number>,
): Promise<FeedbackRefusal | undefined> {
  const conversationId = resolveConversationId(pageConversationId);
  const messageId = input.messageId;
  const ref = messageRef(pageConversationId, messageId);
  if (!ref || ref.kind !== "assistant") return refusal("not_found", "That reply is no longer in this conversation.");
  const type: number = input.type;
  if (!feedbackTypes.has(type) || (input.comment !== undefined &&
      (typeof input.comment !== "string" || input.comment.length > 4000)))
    return refusal("invalid_argument", "This feedback type or comment is not supported.");
  const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.();
  const current = () => !!owner && activation != null && ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation && ctx.isCurrent?.() !== false;
  if (!current()) return refusal("feedback_unavailable", "The account changed. Reopen the conversation.");
  const conversation = await ctx.loadConversation(conversationId);
  if (!current()) return refusal("feedback_unavailable", "The account changed. Reopen the conversation.");
  const turn = conversation && completedReply(conversation, ref.turnId);
  if (!conversation || conversation.id !== conversationId || conversation.mode !== "chat" ||
      conversation.incognito || (conversation.sessionAuthors && conversation.sessionAuthors.ownerAccountUuid !== owner) ||
      !turn || assistantMessageId(turn) !== messageId)
    return refusal("not_found", "That reply is no longer available for feedback.");
  const rating = type === FEEDBACK_UNSPECIFIED ? null : type === FEEDBACK_UPVOTE ? "up" : "down";
  await ctx.call("setReplyFeedback", conversationId, ref.turnId, rating, { localOnly: true });
  if (!current()) return refusal("feedback_unavailable", "The account changed. Reopen the conversation.");
  // Category-only feedback is a report too. A bare thumb remains a rating.
  if (rating && (input.comment !== undefined || type > FEEDBACK_DOWNVOTE)) {
    let outcome: unknown;
    try { outcome = await ctx.call("submitReplyFeedback", {
      conversationId,
      turnId: ref.turnId,
      rating,
      categories: type > FEEDBACK_UPVOTE ? [String(type)] : [],
      comment: input.comment ?? "",
    }); } catch {
      return refusal("feedback_unavailable", "Your rating was saved, but the feedback report could not be confirmed.");
    }
    if (!current()) return refusal("feedback_unavailable", "The account changed. Reopen the conversation.");
    if (!outcome || typeof outcome !== "object" ||
        ((outcome as { sent?: unknown }).sent !== true && (outcome as { queued?: unknown }).queued !== true))
      return refusal("feedback_unavailable", "Your rating was saved, but the feedback report was not sent.");
  }
  return undefined;
}
