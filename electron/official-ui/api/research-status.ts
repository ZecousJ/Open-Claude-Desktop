import { ResearchStopError, stopResearchTask } from "./research-stop";
import { readBoundedJson, RequestBodyError } from "./request-body";
import type http from "node:http";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { resolveConversationId } from "./conversations";
import { researchStatus, researchTask } from "./research-projection";

export async function researchStatusRoute(req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL, ctx: AdapterContext) {
  const m = /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/task\/([^/]+)\/(status|stop)$/.exec(p);
  if (!m) return false;
  const failure = (status: number, message: string) => reply(res, { error: { type: status === 404 ? "not_found_error" : "invalid_request_error", message } }, status);
  if (url.search || req.method !== (m[4] === "stop" ? "POST" : "GET") ||
      (m[4] === "status" && (req.headers["transfer-encoding"] ||
      (req.headers["content-length"] && req.headers["content-length"] !== "0")))) return failure(400, "Unsupported research request.");
  const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.(), root = ctx.stateDirectory?.();
  if (!owner || m[1] !== organizationUuid(owner)) return failure(404, "Research task not found.");
  const current = () => { try { return activation != null && ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation &&
    ctx.stateDirectory?.() === root && ctx.isCurrent?.() !== false; } catch { return false; } };
  try {
    if (!current()) return failure(409, "The research account changed.");
    if (m[4] === "stop") {
      const body = await readBoundedJson(req, 128);
      if (Object.keys(body).length) return failure(400, "Research Stop does not accept extra fields.");
      if (!current()) return failure(409, "The research account changed.");
      return reply(res, await stopResearchTask(ctx, m[2], m[3]));
    }
    const id = resolveConversationId(m[2]);
    const c = await ctx.loadConversation(id);
    if (!current() || resolveConversationId(m[2]) !== id) return failure(409, "The research account changed.");
    if (!c || c.id !== id || c.mode !== "chat" || c.incognito ||
        (c.sessionAuthors?.ownerAccountUuid && c.sessionAuthors.ownerAccountUuid !== owner) ||
        c.turns.length > 10_000 || (c.savedBranches?.length ?? 0) > 199 ||
        (c.savedBranches ?? []).reduce((n, b) => n + b.turns.length, c.turns.length) > 10_000)
      return failure(404, "Research task not found.");
    const turn = researchTask(m[1], c, m[3]);
    if (!turn) return failure(404, "Research task not found.");
    return reply(res, researchStatus(turn));
  } catch (error) {
    if (error instanceof ResearchStopError || error instanceof RequestBodyError) return failure(error.status, error.message);
    return failure(current() ? 503 : 409, current() ? "Research status could not be read." : "The research account changed.");
  }
}
