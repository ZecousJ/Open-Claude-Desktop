/** Pinned official hr/Xp REST search; account-owned Chat only, not Code/Cowork. */
import type http from "node:http";
import { historySearchResult } from "../../../shared/history-search";
import { conversationRow } from "./conversations";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

class SearchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new SearchError(status, message);
};

/** REST uses JS/UTF-16 indices (unlike Recents protobuf code-point ranges).
 * Track case-fold expansion so e.g. İ never shifts following highlights. */
export function conversationSearchMatches(text: string, query: string) {
  const starts: number[] = [],
    ends: number[] = [];
  let folded = "",
    offset = 0;
  for (const char of text) {
    const lower = char.toLocaleLowerCase();
    folded += lower;
    for (let i = 0; i < lower.length; i++) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  const needle = query.toLocaleLowerCase();
  const matches: { start: number; end: number }[] = [];
  if (!needle) return matches;
  for (
    let at = folded.indexOf(needle);
    at >= 0 && matches.length < 200;
    at = folded.indexOf(needle, at + needle.length)
  ) {
    const range = { start: starts[at], end: ends[at + needle.length - 1] };
    if (matches.at(-1)?.end !== range.end) matches.push(range);
  }
  return matches;
}
function snippetText(text: string, max: number) {
  let result = "";
  for (const char of text) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}
export async function conversationSearchRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const match =
    /^\/api\/organizations\/([^/]+)\/conversation\/search\/v2$/.exec(p);
  if (!match) return false;
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  const current = () => {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      fail(409, "The account changed. Search again.");
  };
  try {
    if (req.method !== "POST") fail(405, "Use POST for this read-only search.");
    if (!owner) fail(401, "Sign in to search history.");
    if (match[1] !== organizationUuid(owner!))
      fail(404, "Organization not found.");
    if (new URL(req.url ?? p, "http://adapter.invalid").search)
      fail(400, "Unsupported search parameters.");
    current();
    const body = await readBoundedJson(req, 4096);
    current();
    if (
      Object.keys(body).some(
        (k) =>
          !["query", "n", "target_snippet_size", "project_uuid"].includes(k),
      )
    )
      fail(400, "Unsupported search field.");
    if (typeof body.query !== "string")
      fail(400, "A search query is required.");
    const query = (body.query as string).trim();
    if (
      !query ||
      Array.from(query).length > 200 ||
      /[\u0000-\u001f]/.test(query)
    )
      fail(400, "Search requires 1–200 characters.");
    const n = body.n === undefined ? 20 : body.n,
      size =
        body.target_snippet_size === undefined ? 200 : body.target_snippet_size;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > 200 ||
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 2000
    )
      fail(400, "Invalid search or snippet limit.");
    const project = body.project_uuid;
    if (
      project !== undefined &&
      (typeof project !== "string" ||
        !project ||
        project.length > 100 ||
        /[\u0000-\u001f]/.test(project))
    )
      fail(400, "Invalid project scope.");
    const inventory = await ctx.listConversations();
    current();
    if (!Array.isArray(inventory) || inventory.length > 100000)
      fail(503, "Search inventory is unavailable or too large.");
    const owned = new Map<string, (typeof inventory)[number]>();
    for (const c of inventory) {
      if (
        !c ||
        typeof c.id !== "string" ||
        !c.id ||
        c.id.length > 200 ||
        owned.has(c.id)
      )
        fail(503, "Search inventory is invalid.");
      owned.set(c.id, c);
    }
    const raw = await ctx.call("searchConversations", query, {
      mode: "chat",
      includeArchived: true,
      limit: 50,
      ...(project ? { projectId: project } : {}),
    });
    current();
    // Bound before parsing/cloning an untrusted service answer.
    if (
      !raw ||
      typeof raw !== "object" ||
      !Array.isArray((raw as any).results) ||
      (raw as any).results.length > 50
    )
      fail(503, "Search returned an invalid result.");
    for (const hit of (raw as any).results) {
      if (
        !hit ||
        typeof hit.title !== "string" ||
        hit.title.length > 10000 ||
        (hit.snippet !== undefined &&
          (typeof hit.snippet !== "string" || hit.snippet.length > 100000))
      )
        fail(503, "Search returned an invalid result.");
    }
    const parsed = historySearchResult.safeParse(raw);
    if (!parsed.success) fail(503, "Search returned an invalid result.");
    const hits = parsed.data!.results;
    const seen = new Set<string>();
    const data = [];
    for (const hit of hits) {
      const c = owned.get(hit.conversationId);
      if (
        !c ||
        c.mode !== "chat" ||
        hit.mode !== "chat" ||
        seen.has(hit.conversationId) ||
        (project && c.projectId !== project) ||
        hit.projectId !== c.projectId ||
        hit.archived !== !!c.archived
      )
        fail(
          503,
          "History changed or search results are invalid. Search again.",
        );
      seen.add(hit.conversationId);
      if (c!.incognito) continue;
      if (
        typeof c!.title !== "string" ||
        c!.title.length > 10000 ||
        !Number.isFinite(c!.createdAt) ||
        !Number.isFinite(c!.updatedAt)
      )
        fail(503, "Search inventory is invalid.");
      const text =
        hit.snippet === undefined
          ? undefined
          : snippetText(hit.snippet, size as number);
      data.push({
        conversation: conversationRow(c!),
        title_matches: conversationSearchMatches(c!.title, query),
        matched_snippet:
          text === undefined
            ? null
            : { text, matches: conversationSearchMatches(text, query) },
      });
    }
    // The official search asks for a top-n list, not a cursor page. A full
    // source cap is sufficient when it contains n eligible results. Keep an
    // explicit refusal if a larger request or hidden source hits make that
    // impossible to establish; do not turn an incomplete source into no hits.
    if (hits.length === 50 && data.length < (n as number))
      fail(
        413,
        "The source cannot provide this many eligible Chat search results. Refine the query.",
      );
    const response = {
      data: data.slice(0, n as number),
      search_id: null,
      executed_mode: null,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024)
      fail(413, "Search response is too large.");
    current();
    return reply(res, response);
  } catch (error) {
    return reply(
      res,
      {
        error: {
          type: "invalid_request_error",
          message:
            error instanceof SearchError || error instanceof RequestBodyError
              ? error.message
              : "History search is unavailable. Retry when the service is available.",
        },
      },
      error instanceof SearchError || error instanceof RequestBodyError
        ? error.status
        : 503,
    );
  }
}
