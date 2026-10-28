/**
 * Messages between the provider-service child (the local gateway) and the
 * main process, beyond command replies (S1: R45b and R7-A).
 *
 * The child reads model responses from the network, so the main process
 * validates every signal again with the `parse…` functions below; the child
 * uses the same functions before sending, so both sides agree on the limits.
 */
import type { Citation, WebSource } from "./research-api";
import {
  maxDescriptionLength,
  sanitizeDescription,
  type ToolDescriptionEvent,
} from "./tool-description";

export type { ToolDescriptionEvent } from "./tool-description";

/** Longest thread, call and item id accepted in a signal. */
export const maxSignalIdLength = 500;
/** Most sources kept from one search call. */
export const maxSourcesPerSearch = 100;
/** Most citations kept from one message. */
export const maxCitationsPerMessage = 200;
/** Most URLs kept from a response's citation list. */
export const maxResponseCitations = 200;
/** Longest URL kept, in UTF-8 bytes. */
export const maxSourceUrlBytes = 2048;
export const maxSourceTitleLength = 300;
export const maxSourceSnippetLength = 600;
/**
 * Largest web-sources signal, serialized. Fits the largest signal the
 * limits above allow (100 sources or 200 citations with URLs of 2 KB), so a
 * search with many long results is not dropped as a whole.
 */
export const maxWebSourcesSignalBytes = 1024 * 1024;

/** A web search (or grok X search) call finished, with the pages it read. */
export interface WebSearchSourcesEvent {
  kind: "search";
  threadId: string;
  /** The upstream output item id; Codex uses it as the webSearch item id. */
  callId: string;
  tool: "web_search" | "x_search";
  queries: string[];
  sources: WebSource[];
  status: "completed" | "failed";
}

/** A finished assistant message's citations, as UTF-16 offsets of its text. */
export interface MessageCitationsEvent {
  kind: "message";
  threadId: string;
  /** The upstream message id; Codex uses it as the agentMessage item id. */
  itemId?: string;
  /** Length (UTF-16) and SHA-256 (hex, of UTF-8) of the text the offsets index. */
  textLength: number;
  textHash: string;
  citations: Citation[];
}

/** A response's own list of cited URLs (xAI `response.citations`). */
export interface ResponseCitationsEvent {
  kind: "citations";
  threadId: string;
  responseId: string;
  /** The last assistant message of that response, when it had one. */
  messageId?: string;
  urls: string[];
}

export type WebSourcesEvent =
  WebSearchSourcesEvent | MessageCitationsEvent | ResponseCitationsEvent;

/** Gateway → main process signals (besides `agentPrompt` and `remoteRefusal`). */
export type GatewaySignal =
  | ({ type: "toolDescription" } & ToolDescriptionEvent)
  | { type: "webSources"; event: WebSourcesEvent };

/**
 * How the gateway rewrites requests; the main process sends it with the
 * `requestOptions` command whenever it changes.
 */
export interface GatewayRequestOptions {
  /** Add a `description` parameter to Codex's shell tools (R7). */
  describeTools: boolean;
  /**
   * Models that may also search X (grok's `x_search` tool) whenever a request
   * carries the web search tool. Empty turns X search off (R45).
   */
  xSearchModels: string[];
  /**
   * The image model every picture is made with (sidebar → API → Image
   * generation); empty leaves each request's own model.
   */
  imageModel?: string;
}

export const defaultRequestOptions: GatewayRequestOptions = Object.freeze({
  describeTools: true,
  xSearchModels: [],
}) as GatewayRequestOptions;

const maxRequestOptionModels = 500;

export function parseRequestOptions(
  value: unknown,
): GatewayRequestOptions | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.describeTools !== "boolean") return;
  if (
    !Array.isArray(raw.xSearchModels) ||
    raw.xSearchModels.length > maxRequestOptionModels ||
    !raw.xSearchModels.every(
      (model) => typeof model === "string" && model && model.length <= 200,
    )
  )
    return;
  const imageModel =
    typeof raw.imageModel === "string" &&
    raw.imageModel.length <= 200 &&
    /^[\w.:/-]*$/.test(raw.imageModel)
      ? raw.imageModel
      : "";
  return {
    describeTools: raw.describeTools,
    xSearchModels: [...new Set(raw.xSearchModels as string[])],
    ...(imageModel ? { imageModel } : {}),
  };
}

const encoder = new TextEncoder();
/** UTF-8 byte length (shared code runs without Node's Buffer too). */
export function utf8Length(value: string) {
  return encoder.encode(value).length;
}

function signalId(value: unknown): value is string {
  return (
    typeof value === "string" && !!value && value.length <= maxSignalIdLength
  );
}

export function parseToolDescriptionSignal(
  value: unknown,
): ToolDescriptionEvent | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (!signalId(raw.threadId) || !signalId(raw.callId)) return;
  if (
    typeof raw.description !== "string" ||
    raw.description.length > 4 * maxDescriptionLength
  )
    return;
  const description = sanitizeDescription(raw.description);
  if (!description) return;
  return { threadId: raw.threadId, callId: raw.callId, description };
}

/**
 * A web address a source or citation may carry: absolute http(s), no
 * credentials, bounded. Returns the normalized href.
 */
export function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return;
  if (utf8Length(value) > maxSourceUrlBytes) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  if (url.username || url.password || !url.hostname) return;
  const href = url.href;
  return utf8Length(href) <= maxSourceUrlBytes ? href : undefined;
}

function boundedText(value: unknown, limit: number) {
  if (typeof value !== "string") return;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return;
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit).join("") : text;
}

export function cleanWebSource(value: unknown): WebSource | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  const url = sourceUrl(raw.url);
  if (!url) return;
  const title = boundedText(raw.title, maxSourceTitleLength);
  const snippet = boundedText(
    raw.snippet ?? raw.description ?? raw.text,
    maxSourceSnippetLength,
  );
  return {
    url,
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

/** Sources without duplicate URLs (the first title wins), at most `limit`. */
export function uniqueSources(
  values: unknown[],
  limit = maxSourcesPerSearch,
): WebSource[] {
  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const value of values) {
    const source = cleanWebSource(value);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

function cleanCitation(value: unknown, textLength: number) {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  const url = sourceUrl(raw.url);
  const { start, end } = raw;
  if (
    !url ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number) ||
    (end as number) > textLength
  )
    return;
  const title = boundedText(raw.title, maxSourceTitleLength);
  return {
    url,
    ...(title ? { title } : {}),
    start: start as number,
    end: end as number,
  } satisfies Citation;
}

/** Valid citations of a text of `textLength` UTF-16 units, at most the per-message limit. */
export function cleanCitations(
  values: unknown,
  textLength: number,
): Citation[] {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, maxCitationsPerMessage)
    .map((value) => cleanCitation(value, textLength))
    .filter((citation): citation is Citation => !!citation);
}

const hexHash = /^[0-9a-f]{64}$/;

export function parseWebSourcesSignal(
  value: unknown,
): WebSourcesEvent | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (!signalId(raw.threadId)) return;
  try {
    if (JSON.stringify(raw).length > maxWebSourcesSignalBytes) return;
  } catch {
    return;
  }
  if (raw.kind === "search") {
    if (!signalId(raw.callId)) return;
    if (raw.tool !== "web_search" && raw.tool !== "x_search") return;
    if (raw.status !== "completed" && raw.status !== "failed") return;
    if (!Array.isArray(raw.queries) || !Array.isArray(raw.sources)) return;
    return {
      kind: "search",
      threadId: raw.threadId,
      callId: raw.callId,
      tool: raw.tool,
      status: raw.status,
      queries: raw.queries
        .map((query) => boundedText(query, 1000))
        .filter((query): query is string => !!query)
        .slice(0, 20),
      sources: uniqueSources(raw.sources),
    };
  }
  if (raw.kind === "message") {
    const { textLength, textHash } = raw;
    if (
      !Number.isSafeInteger(textLength) ||
      (textLength as number) <= 0 ||
      typeof textHash !== "string" ||
      !hexHash.test(textHash) ||
      !Array.isArray(raw.citations)
    )
      return;
    if (raw.itemId !== undefined && !signalId(raw.itemId)) return;
    const citations = cleanCitations(raw.citations, textLength as number);
    if (!citations.length) return;
    return {
      kind: "message",
      threadId: raw.threadId,
      ...(raw.itemId ? { itemId: raw.itemId as string } : {}),
      textLength: textLength as number,
      textHash,
      citations,
    };
  }
  if (raw.kind === "citations") {
    if (!signalId(raw.responseId) || !Array.isArray(raw.urls)) return;
    if (raw.messageId !== undefined && !signalId(raw.messageId)) return;
    const urls = [
      ...new Set(raw.urls.map(sourceUrl).filter((url): url is string => !!url)),
    ].slice(0, maxResponseCitations);
    if (!urls.length) return;
    return {
      kind: "citations",
      threadId: raw.threadId,
      responseId: raw.responseId,
      ...(raw.messageId ? { messageId: raw.messageId as string } : {}),
      urls,
    };
  }
  return;
}
