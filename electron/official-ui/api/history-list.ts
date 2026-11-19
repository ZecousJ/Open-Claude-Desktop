/** Legacy Recents list/search. The newer ListRecents RPC is a separate contract. */
import type http from "node:http";
import { historySearchResult } from "../../../shared/history-search";
import type { Conversation } from "../../../shared/types";
import type { ConversationMeta } from "../../../shared/web-docs";
import { conversationRow, conversationTimes, isChat } from "./conversations";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { cloudCodeSessionKey, isOwnedCloudCoworkSession } from "./cloud-code-history";
class HistoryListError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HistoryListError(status, message);
};
export async function historyListRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const match = /^\/api\/organizations\/([^/]+)\/chat_conversations_v2$/.exec(
    p,
  );
  if (!match) return false;
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  const current = () => {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      fail(409, "The account changed. Reopen history.");
  };
  try {
    if (req.method !== "GET") fail(405, "History listing is read-only.");
    if (!owner) fail(401, "Sign in to read history.");
    if (match[1] !== organizationUuid(owner!))
      fail(404, "Organization not found.");
    const params = url.searchParams;
    const allowed = [
      "limit",
      "offset",
      "starred",
      "archived",
      "searchQuery",
      "project_uuid",
      "consistency",
    ];
    if (
      [...params.keys()].some((k) => !allowed.includes(k)) ||
      allowed.some((k) => params.getAll(k).length > 1)
    )
      fail(400, "Unsupported history query.");
    const number = (key: string, fallback: number, max: number) => {
      const raw = params.get(key);
      if (raw === null) return fallback;
      if (
        !/^(0|[1-9][0-9]*)$/.test(raw) ||
        !Number.isSafeInteger(Number(raw)) ||
        Number(raw) > max ||
        (key === "limit" && Number(raw) < 1)
      )
        fail(400, "Invalid history pagination.");
      return Number(raw);
    };
    const limit = number("limit", 30, 200),
      offset = number("offset", 0, 100000);
    for (const key of ["starred", "archived"])
      if (params.has(key) && !["true", "false"].includes(params.get(key)!))
        fail(400, "Invalid history filter.");
    if (
      params.has("consistency") &&
      !["strong", "eventual"].includes(params.get("consistency")!)
    )
      fail(400, "Unsupported history consistency.");
    const starred = params.get("starred") === "true",
      archived = params.get("archived") === "true";
    const project = params.get("project_uuid");
    if (
      project !== null &&
      (!project || project.length > 100 || /[\u0000-\u001f]/.test(project))
    )
      fail(400, "Invalid project filter.");
    const query = (params.get("searchQuery") ?? "").trim();
    if (Array.from(query).length > 200 || /[\u0000-\u001f]/.test(query))
      fail(400, "History search is limited to 200 characters.");
    current();
    const source = (query ? undefined : ctx.conversationInventory?.()) ?? await ctx.listConversations();
    current();
    if (!Array.isArray(source) || source.length > 100000)
      fail(413, "History inventory exceeds the supported bound.");
    const seen = new Set<string>();
    for (const c of source) {
      if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id))
        fail(503, "History inventory is invalid.");
      seen.add(c.id);
    }
    const load = async (conversation: Conversation | ConversationMeta) => {
      if ("turns" in conversation) return conversation;
      const loaded = await ctx.loadConversation(conversation.id);
      current();
      if (!loaded) return fail(503, "History changed. Reload history.");
      return loaded;
    };
    const eligible = source
      .filter(isChat)
      .filter(c => !(c.mode === "cowork" && ctx.localListConversations && ctx.localLoadConversation &&
        (!c.environment || c.environment.kind === "local") && !c.cloudHosted &&
        !c.linkedToComputer && !c.chatDeviceBinding && !ctx.isCloudConversation?.(c.id)))
      .filter((c) => !c.incognito)
      .filter((c) => !!c.archived === archived)
      .filter((c) => !starred || c.pinned)
      .filter((c) => !project || c.projectId === project);
    let rows: { conversation: Conversation | ConversationMeta; updated: number }[] = [];
    for (const candidate of eligible) {
      const conversation = candidate.updatedAt || "turns" in candidate ? candidate : await load(candidate);
      const updated = "turns" in conversation ? conversationTimes(conversation).updated : conversation.updatedAt;
      rows.push({ conversation, updated });
    }
    if (query) {
      const matches = new Set<string>();
      const modes = new Map(rows.map(({ conversation }) => [conversation.id, conversation.mode]));
      for (const mode of ["chat", "cowork"] as const) {
        if (!rows.some(({ conversation }) => conversation.mode === mode)) continue;
        const ids = new Set<string>();
        for (let sourceOffset = 0; sourceOffset < rows.length && sourceOffset <= offset + limit; sourceOffset += 50) {
          current();
          const raw = await ctx.call("searchConversations", query, {
            mode,
            includeArchived: archived,
            limit: 50,
            page: { offset: sourceOffset, archive: archived ? "archived" : "active", starredOnly: starred },
            ...(project ? { projectId: project } : {}),
          });
          current();
          const parsed = historySearchResult.safeParse(raw);
          if (!parsed.success || parsed.data.results.length > 50)
            fail(503, "History search returned an invalid result.");
          const hits = parsed.data!.results;
          for (const hit of hits) {
            if (hit.mode !== mode || ids.has(hit.conversationId) || modes.get(hit.conversationId) !== mode)
              fail(503, "History changed or search results are invalid. Search again.");
            ids.add(hit.conversationId);
            matches.add(hit.conversationId);
          }
          if (hits.length < 50 || ids.size >= offset + limit + 1) break;
        }
      }
      rows = rows.filter(({ conversation }) => matches.has(conversation.id));
    }
    rows.sort((a, b) => b.updated - a.updated || a.conversation.id.localeCompare(b.conversation.id));
    const selected = rows.slice(offset, offset + limit);
    const page: Conversation[] = [];
    for (let start = 0; start < selected.length; start += 8) {
      page.push(...await Promise.all(selected.slice(start, start + 8).map(({ conversation }) => load(conversation))));
    }
    const data = page.map((conversation) => ({
      ...conversationRow(conversation),
      ...(ctx.officialCoworkHistory && isOwnedCloudCoworkSession(conversation, owner!)
        ? { claudex_cowork_session: "session_" + cloudCodeSessionKey(conversation, owner!) }
        : {}),
    }));
    if (Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024)
      fail(413, "History page is too large.");
    current();
    return reply(res, {
      data,
      pagination: { has_more: rows.length > offset + limit },
      has_more: rows.length > offset + limit,
    });
  } catch (error) {
    return reply(
      res,
      {
        error: {
          type: "invalid_request_error",
          message:
            error instanceof HistoryListError
              ? error.message
              : "History could not be read. Retry when the service is available.",
        },
      },
      error instanceof HistoryListError ? error.status : 503,
    );
  }
}
