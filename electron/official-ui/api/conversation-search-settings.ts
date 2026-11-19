/** Native REST fallback for the original per-conversation search preference. */
import type http from "node:http";
import type { Conversation } from "../../../shared/types";
import { organizationUuid, reply, type AdapterContext } from "./context";

export async function saveConversationSearchSettings(
  res: http.ServerResponse,
  path: string,
  body: unknown,
  pageId: string,
  resolve: (id: string) => string,
  ctx: AdapterContext,
  row: (conversation: Conversation) => unknown,
): Promise<boolean> {
  const error = (status: number, message: string) => reply(res, {
    type: "error", error: { type: "api_error", message,
      details: { error_visibility: "user_facing" } },
  }, status);
  if (ctx.readOnly || ctx.strictActionSemantics)
    return error(403, "Use the supported conversation settings control on this host.");
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !("settings" in body))
    return error(400, "Update the web search setting separately.");
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).length !== 1 || !("enabled_web_search" in settings) ||
      typeof settings.enabled_web_search !== "boolean")
    return error(400, "Only a boolean enabled_web_search setting is supported.");
  const enabled = settings.enabled_web_search;
  const owner = ctx.account()?.id, identity = ctx.sessionIdentity?.(), directory = ctx.stateDirectory?.();
  const org = /^\/api\/organizations\/([^/]+)\//.exec(path)?.[1];
  if (!owner || org !== organizationUuid(owner))
    return error(404, "Conversation not found.");
  const id = resolve(pageId);
  const current = () => ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity && ctx.stateDirectory?.() === directory &&
    ctx.isCurrent?.() !== false && resolve(pageId) === id;
  const owned = (c: Awaited<ReturnType<AdapterContext["loadConversation"]>>) =>
    c?.id === id && (c.mode === "chat" || c.mode === "cowork") &&
    (!c.sessionAuthors?.ownerAccountUuid || c.sessionAuthors.ownerAccountUuid === owner);
  try {
    if (!current()) return error(409, "The account changed during this request.");
    const before = await ctx.loadConversation(id);
    if (!current()) return error(409, "The account changed during this request.");
    if (!owned(before)) return error(404, "Conversation not found.");
    // The native handler owns policy, provider/protocol, busy state, persistence
    // and engine reload. This fallback never updates unrelated metadata.
    await ctx.call("setConversationWebSearch", id, enabled);
    if (!current()) return error(409, "The account changed before the save could be confirmed.");
    const saved = await ctx.loadConversation(id);
    if (!current() || !owned(saved) || saved?.createdAt !== before?.createdAt ||
        Boolean(saved?.webSearch) !== enabled)
      return error(409, "The web search setting could not be confirmed. Reopen the conversation.");
    return reply(res, row(saved!));
  } catch {
    return error(503, "The web search setting could not be confirmed. Reopen the conversation before retrying.");
  }
}
