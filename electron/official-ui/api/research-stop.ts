import { researchFinished } from "../../../shared/research";
import { organizationUuid, type AdapterContext } from "./context";
import { resolveConversationId } from "./conversations";
import { researchTask } from "./research-projection";

export class ResearchStopError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
/** Shared exact-task boundary for the original REST Stop and protobuf action. */
export async function stopResearchTask(ctx: AdapterContext, pageId: string, taskId: unknown) {
  const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.(), root = ctx.stateDirectory?.();
  const current = () => {
    try { return !!owner && activation != null && ctx.account()?.id === owner &&
      ctx.sessionIdentity?.() === activation && ctx.stateDirectory?.() === root && ctx.isCurrent?.() !== false; }
    catch { return false; }
  };
  const changed = () => { throw new ResearchStopError(409, "stop_unconfirmed", "The research account changed."); };
  if (!current()) changed();
  const id = resolveConversationId(pageId);
  const c = await ctx.loadConversation(id);
  if (!current() || resolveConversationId(pageId) !== id) changed();
  if (!c || c.id !== id || c.mode !== "chat" || c.incognito ||
      (c.sessionAuthors?.ownerAccountUuid && c.sessionAuthors.ownerAccountUuid !== owner))
    throw new ResearchStopError(404, "stop_target_unavailable", "That research task is unavailable.");
  const turn = researchTask(organizationUuid(owner!), c, taskId);
  if (!turn || c.turns.at(-1) !== turn || turn.status !== "inProgress" || !turn.research || researchFinished(turn.research))
    throw new ResearchStopError(409, "stop_target_unavailable", "That research task is no longer running on the current turn.");
  const result = await ctx.call("interrupt", id, {
    turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt,
    ...(c.threadId ? { threadId: c.threadId } : {}),
  });
  if (!current() || resolveConversationId(pageId) !== id) changed();
  if (!result || typeof result !== "object" || !("status" in result) ||
      (result.status !== "accepted" && result.status !== "already_finished"))
    throw new ResearchStopError(409, "stop_unconfirmed", "The stop request could not be confirmed for that research task.");
  return { status: result.status };
}
