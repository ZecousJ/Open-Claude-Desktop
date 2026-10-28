/**
 * R45b: web search sources and citations read beside the stream Codex gets.
 *
 * Codex 0.144.1 keeps only the query of a `web_search_call`, drops
 * `annotations` from `output_text`, and ignores grok's `x_search_call`
 * items altogether (they are not replayed either). The gateway therefore
 * reads them from the same observed copy of the SSE stream that already
 * feeds usage and child-agent prompts, and reports them to the main process.
 * The bytes sent to Codex are never changed.
 *
 * Observed on 0.144.1 (S1 probe): the webSearch item id is the upstream
 * `web_search_call` id and the agentMessage item id is the upstream message
 * id, so both match by id.
 */
import { createHash } from "node:crypto";
import type { Citation } from "../shared/research-api";
import {
  maxCitationsPerMessage,
  maxResponseCitations,
  maxSignalIdLength,
  maxSourceTitleLength,
  parseWebSourcesSignal,
  sourceUrl,
  uniqueSources,
  type WebSourcesEvent,
} from "../shared/gateway-signals";

type Json = Record<string, any>;

/** Sources are requested for these built-in search tools. */
const searchIncludes: Record<string, string> = {
  web_search: "web_search_call.action.sources",
  x_search: "x_search_call.action.sources",
};
/** Longest message text whose citation offsets are converted. */
const maxCitedTextLength = 1_000_000;

function hasTool(request: Json, type: string) {
  return (
    Array.isArray(request.tools) &&
    request.tools.some((tool: unknown) => (tool as Json)?.type === type)
  );
}

/**
 * The request with search sources asked for, and grok's X search added:
 * only when it already carries the built-in `web_search` tool (a
 * conversation with web search on). The input object is not changed.
 */
export function augmentWebSearchRequest<T extends Json>(
  request: T,
  options: { xSearch: boolean },
): T {
  if (!hasTool(request, "web_search")) return request;
  const tools: unknown[] = [...request.tools];
  if (options.xSearch && !hasTool(request, "x_search"))
    tools.push({ type: "x_search" });
  const include = Array.isArray(request.include)
    ? request.include.filter((value: unknown) => typeof value === "string")
    : [];
  for (const tool of ["web_search", "x_search"])
    if (tools.some((value) => (value as Json)?.type === tool))
      include.push(searchIncludes[tool]);
  return { ...request, tools, include: [...new Set(include)] };
}

function signalThread(threadId: unknown): threadId is string {
  return (
    typeof threadId === "string" &&
    !!threadId &&
    threadId.length <= maxSignalIdLength
  );
}

/** Index tables from code points and UTF-8 bytes to UTF-16 offsets. */
function offsetTables(text: string) {
  const fromPoints: number[] = [0];
  const fromBytes = new Map<number, number>([[0, 0]]);
  let units = 0;
  let bytes = 0;
  for (const char of text) {
    units += char.length;
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    fromPoints.push(units);
    fromBytes.set(bytes, units);
  }
  return { fromPoints, fromBytes };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * A citation's span in UTF-16 code units. Providers count offsets
 * differently (code points, UTF-16 units or UTF-8 bytes; R45 Q2 is still
 * open), so each reading is tried and the one whose text names the cited
 * page wins; with no such evidence, code points (OpenAI's documented unit)
 * come first, then UTF-16, then bytes. undefined when no reading fits.
 */
export function citationSpan(
  text: string,
  start: number,
  end: number,
  url: string,
  tables = offsetTables(text),
): { start: number; end: number } | undefined {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  )
    return;
  const candidates: { start: number; end: number }[] = [];
  const add = (s: number | undefined, e: number | undefined) => {
    if (s === undefined || e === undefined || e <= s || e > text.length) return;
    // Never split a surrogate pair.
    const splits = (at: number) =>
      at > 0 &&
      at < text.length &&
      /[\ud800-\udbff]/.test(text[at - 1]) &&
      /[\udc00-\udfff]/.test(text[at]);
    if (splits(s) || splits(e)) return;
    if (!candidates.some((c) => c.start === s && c.end === e))
      candidates.push({ start: s, end: e });
  };
  add(tables.fromPoints[start], tables.fromPoints[end]);
  add(start, end);
  add(tables.fromBytes.get(start), tables.fromBytes.get(end));
  if (!candidates.length) return;
  const host = hostOf(url);
  const count = (value: string, char: string) => value.split(char).length - 1;
  const score = (span: { start: number; end: number }) => {
    const cited = text.slice(span.start, span.end).toLowerCase();
    const names = cited.includes(url.toLowerCase())
      ? 4
      : host && cited.includes(host)
        ? 2
        : 0;
    // A cited link is usually a whole "([title](url))": balanced brackets.
    const balanced =
      count(cited, "(") === count(cited, ")") &&
      count(cited, "[") === count(cited, "]");
    return names + (names && balanced ? 1 : 0);
  };
  let best = candidates[0];
  for (const candidate of candidates.slice(1))
    if (score(candidate) > score(best)) best = candidate;
  return best;
}

function messageCitations(item: Json, threadId: string) {
  const parts = Array.isArray(item.content) ? item.content : [];
  let text = "";
  const raw: { url: unknown; title: unknown; start: number; end: number }[] =
    [];
  const pending: { offset: number; part: Json }[] = [];
  for (const part of parts) {
    if (part?.type !== "output_text" || typeof part.text !== "string") continue;
    pending.push({ offset: text.length, part });
    text += part.text;
  }
  if (!text || text.length > maxCitedTextLength) return;
  for (const { offset, part } of pending) {
    if (!Array.isArray(part.annotations)) continue;
    const tables = offsetTables(part.text);
    for (const annotation of part.annotations) {
      if (raw.length >= maxCitationsPerMessage) break;
      if (annotation?.type !== "url_citation") continue;
      const url = sourceUrl(annotation.url);
      if (!url) continue;
      const span = citationSpan(
        part.text,
        annotation.start_index,
        annotation.end_index,
        url,
        tables,
      );
      if (!span) continue;
      raw.push({
        url,
        title:
          typeof annotation.title === "string"
            ? annotation.title.slice(0, 4 * maxSourceTitleLength)
            : undefined,
        start: span.start + offset,
        end: span.end + offset,
      });
    }
  }
  if (!raw.length) return;
  return parseWebSourcesSignal({
    kind: "message",
    threadId,
    ...(typeof item.id === "string" &&
    item.id &&
    item.id.length <= maxSignalIdLength
      ? { itemId: item.id }
      : {}),
    textLength: text.length,
    textHash: createHash("sha256").update(text).digest("hex"),
    citations: raw as Citation[],
  });
}

function searchSources(item: Json, threadId: string) {
  if (
    typeof item.id !== "string" ||
    !item.id ||
    item.id.length > maxSignalIdLength
  )
    return;
  const action =
    item.action && typeof item.action === "object" ? item.action : {};
  const queries = [
    action.query,
    ...(Array.isArray(action.queries) ? action.queries : []),
  ].filter((query): query is string => typeof query === "string" && !!query);
  const sources = [action.sources, item.sources, item.results].find(
    Array.isArray,
  );
  return parseWebSourcesSignal({
    kind: "search",
    threadId,
    callId: item.id,
    tool: item.type === "x_search_call" ? "x_search" : "web_search",
    queries: [...new Set(queries)],
    sources: uniqueSources(sources ?? []),
    status: item.status === "failed" ? "failed" : "completed",
  });
}

function responseCitations(response: Json, threadId: string) {
  if (!Array.isArray(response?.citations)) return;
  if (typeof response.id !== "string") return;
  const urls = response.citations
    .slice(0, 4 * maxResponseCitations)
    .map((value: unknown) =>
      typeof value === "string" ? value : (value as Json)?.url,
    );
  const message = (Array.isArray(response.output) ? response.output : [])
    .filter(
      (item: unknown) =>
        (item as Json)?.type === "message" &&
        typeof (item as Json).id === "string",
    )
    .at(-1);
  return parseWebSourcesSignal({
    kind: "citations",
    threadId,
    responseId: response.id,
    ...(message ? { messageId: message.id } : {}),
    urls,
  });
}

/** What one observed Responses event says about sources and citations. */
export function webSourcesFromResponse(
  event: any,
  threadId: unknown,
): WebSourcesEvent | undefined {
  if (!signalThread(threadId)) return;
  try {
    if (event?.type === "response.output_item.done") {
      const item = event.item;
      if (item?.type === "web_search_call" || item?.type === "x_search_call")
        return searchSources(item, threadId);
      if (item?.type === "message" && item.role !== "user")
        return messageCitations(item, threadId);
      return;
    }
    if (event?.type === "response.completed")
      return responseCitations(event.response, threadId);
  } catch {
    /* Observation never affects the forwarded stream. */
  }
  return;
}
