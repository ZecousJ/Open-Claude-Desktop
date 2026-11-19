import type http from "node:http";
import { z } from "zod";
import { officialReplyFeedbackTarget, legacyReplyFeedbackTypes } from "../../../shared/official-reply-feedback";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { applyReplyFeedback } from "./reply-feedback";

const bodySchema = z.object({
  type: z.string(),
  reason: z.string().max(4000).optional(),
  artifacts: z.array(z.unknown()).max(64).optional(),
}).strict();
const feedbackTypes = new Set(legacyReplyFeedbackTypes.values());

export async function restReplyFeedbackRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext): Promise<boolean> {
  const target = officialReplyFeedbackTarget(req.method ?? "", url.pathname);
  if (!target) return false;
  const fail = (status: number, message: string) => reply(res, { type: "error", error: { type: "invalid_request_error", message } }, status);
  if (url.search || !/^application\/json(?:\s*;.*)?$/i.test(String(req.headers["content-type"] ?? "")))
    return fail(400, "Invalid feedback request.");
  const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.();
  const current = () => !!owner && activation != null && activation !== "" && ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation && ctx.isCurrent?.() !== false;
  if (!current()) return fail(409, "The account activation changed.");
  if (target.organizationId !== organizationUuid(owner!)) return fail(404, "The conversation is unavailable.");
  let body: z.infer<typeof bodySchema>;
  try { body = bodySchema.parse(await readBoundedJson(req, 32 * 1024)); }
  catch (error) { return fail(error instanceof RequestBodyError ? error.status : 400, "Invalid feedback request."); }
  if (!current()) return fail(409, "The account activation changed.");
  const type = legacyReplyFeedbackTypes.get(body.type);
  if (type === undefined) return fail(400, "This feedback type is not supported.");
  const result = await applyReplyFeedback(ctx, target.conversationId, {
    messageId: target.messageId, type, ...(body.reason !== undefined ? { comment: body.reason } : {}),
  }, feedbackTypes);
  if (!current()) return fail(409, "The account activation changed.");
  if (result) return fail(result.code === "not_found" ? 404 : result.code === "invalid_argument" ? 400 : 503, result.message);
  return reply(res, { type: body.type });
}
