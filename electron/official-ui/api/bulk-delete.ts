/** Recents batch deletion through the current account. */
import type http from "node:http";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";
export async function bulkDeleteRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  url: URL,
  ctx: AdapterContext,
  resolve: (id: string) => string,
): Promise<boolean> {
  if (
    req.method !== "POST" ||
    !path.endsWith("/chat_conversations/delete_many")
  )
    return false;
  let owner: string | undefined, activation: unknown;
  try {
    owner = ctx.account()?.id;
    activation = ctx.sessionIdentity?.();
  } catch {
    return reply(res, { error: "Account activation unavailable" }, 409);
  }
  const current = () => {
    try {
      return (
        !!owner &&
        activation !== undefined &&
        activation !== null &&
        typeof ctx.sessionIdentity === "function" &&
        typeof ctx.isCurrent === "function" &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === activation &&
        ctx.isCurrent() === true
      );
    } catch {
      return false;
    }
  };
  const conflict = () =>
    reply(
      res,
      {
        error: {
          type: "conflict_error",
          message:
            "The account changed. Refresh status before retrying; an earlier deletion may already have completed.",
        },
      },
      409,
    );
  if (
    !owner ||
    path !==
      `/api/organizations/${organizationUuid(owner)}/chat_conversations/delete_many`
  )
    return reply(res, { error: "Conversation not found" }, 404);
  if (!current()) return conflict();
  if (ctx.readOnly && !ctx.allowChatBulkDelete)
    return reply(
      res,
      { error: "Bulk deletion is unavailable in this interface" },
      501,
    );
  if (url.search || url.hash)
    return reply(res, { error: "Unexpected batch query" }, 400);
  let body: unknown;
  try {
    body = await readBoundedJson(req, 256 * 1024);
  } catch (error) {
    return reply(
      res,
      { error: "Invalid deletion batch" },
      error instanceof RequestBodyError ? error.status : 400,
    );
  }
  if (!current()) return conflict();
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          "conversation_uuids",
          "delete_cowork_session_conversation_uuids",
        ].includes(key),
    ) ||
    !("conversation_uuids" in body)
  )
    return reply(res, { error: "Invalid deletion batch" }, 400);
  const ids = (body as { conversation_uuids: unknown }).conversation_uuids;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 1000 ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !id.length ||
        id.length > 200 ||
        id !== id.trim() ||
        /[\x00-\x20\x7f/\\]/.test(id),
    ) ||
    new Set(ids).size !== ids.length
  )
    return reply(res, { error: "Invalid deletion batch" }, 400);
  const cowork = (
    body as { delete_cowork_session_conversation_uuids?: unknown }
  ).delete_cowork_session_conversation_uuids;
  if (
    cowork !== undefined &&
    (!Array.isArray(cowork) ||
      cowork.some((id) => typeof id !== "string" || !ids.includes(id)) ||
      new Set(cowork).size !== cowork.length)
  )
    return reply(res, { error: "Invalid Cowork deletion selection" }, 400);
  let resolved: string[];
  try {
    resolved = ids.map((id) => resolve(id));
    if (
      resolved.some(
        (id) =>
          typeof id !== "string" ||
          !id.length ||
          id.length > 200 ||
          id !== id.trim() ||
          /[\x00-\x20\x7f/\\]/.test(id),
      )
    )
      throw Error("Invalid alias");
  } catch {
    return reply(
      res,
      { error: "Conversation aliases could not be verified" },
      409,
    );
  }
  if (new Set(resolved).size !== resolved.length)
    return reply(res, { error: "Duplicate conversation aliases" }, 400);
  // Preflight the entire owned selection, before the first irreversible mutation.
  try {
    for (const id of resolved) {
      if (!current()) return conflict();
      const conversation = await ctx.loadConversation(id);
      if (!current()) return conflict();
      if (!conversation || conversation.id !== id || (conversation.sessionAuthors &&
          (conversation.sessionAuthors.ownerAccountUuid !== owner ||
            conversation.sessionAuthors.viewerAccountUuid !== owner)))
        return reply(res, { error: "Conversation not found" }, 404);
      if (
        conversation.mode !== "chat" ||
        (Array.isArray(cowork) && cowork.length)
      )
        return reply(
          res,
          {
            error:
              "This task deletion mode is not supported by the Chat batch adapter",
          },
          501,
        );
    }
  } catch {
    if (!current()) return conflict();
    return reply(
      res,
      { error: "The deletion selection could not be verified" },
      503,
    );
  }
  const deleted: string[] = [],
    failed: { uuid: string; error: string }[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!current()) return conflict();
    try {
      if (ids.some((id, index) => resolve(id) !== resolved[index]))
        return conflict();
    } catch {
      return conflict();
    }
    try {
      await ctx.call("deleteConversation", resolved[i]);
      if (!current()) return conflict();
      deleted.push(ids[i]);
    } catch {
      if (!current()) return conflict();
      failed.push({
        uuid: ids[i],
        error:
          "Deletion could not be confirmed. Refresh its status before trying again.",
      });
    }
  }
  return reply(res, { deleted, failed });
}
