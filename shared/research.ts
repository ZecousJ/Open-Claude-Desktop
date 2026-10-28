/**
 * Research mode and web search results (R4/R5, design R45): the data a
 * transcript stores, and the rules the main process and the window share
 * (when Research can be used, how a Research turn's sources are counted and
 * how long it ran). Pure: no Node or DOM APIs.
 *
 * Where the data lives: `Item.sources` / `Item.searchTool` on webSearch
 * items, `Item.citations` (and `Item.webCitations`, xAI's URL list) on
 * agentMessage items, `Turn.research` on a Research turn and
 * `Conversation.research` on a Chat whose Research switch is on.
 */
import type { ClientPolicy } from "./client-policy";
import { researchPolicyOf } from "./client-policy";
import { connectorAllowed } from "./client-policy-rules";
import type { ModelCatalogItem } from "./model-catalog-api";
import type { Conversation, Mode, Provider, Settings, Turn } from "./types";
import { modelProtocol } from "./provider-routes";

/** One page a web search returned. */
export interface WebSource {
  url: string;
  title?: string;
  snippet?: string;
}

/** A span of a reply that cites a page; offsets count UTF-16 code units of the reply text. */
export interface Citation {
  url: string;
  title?: string;
  start: number;
  end: number;
}

/** Where a Research turn is. */
export type ResearchPhase =
  | "starting"
  | "planning"
  | "gathering"
  | "writing"
  | "done"
  | "failed"
  | "interrupted";

/** A Research turn's progress and report. */
export interface ResearchState {
  /** The model's title for the research (from its plan, then its report). */
  title?: string;
  /** The sub-questions of the model's plan. */
  questions?: string[];
  plan?: string;
  state: ResearchPhase;
  error?: "model_access" | "research_failed";
  errorModel?: string;
  startedAt: number;
  completedAt?: number;
  writingStartedAt?: number;
  /** Distinct pages the turn's searches returned or its replies cited. */
  sourceCount: number;
  /** Searches the turn ran so far (web and X). */
  searchCount?: number;
  /**
   * The finished report. `path` is relative to the account's folder
   * (`research/<conversation>/<file>.md`); the window reads it through
   * `readResearchReport`, never by path.
   */
  report?: { title: string; path: string; bytes: number };
  /**
   * How the report was made: "tool" when the model submitted it with
   * research_report, "reply" when its final reply stands in for one.
   */
  reportSource?: "tool" | "reply";
}

/** Research turns that are over (the card stops its clock). */
export const researchFinished = (state: ResearchState) =>
  state.state === "done" ||
  state.state === "failed" ||
  state.state === "interrupted";

/** Longest research title kept. */
export const maxResearchTitleLength = 200;
/** Most plan questions kept, and the longest one. */
export const maxResearchQuestions = 8;
export const maxResearchQuestionLength = 300;
/** Largest report accepted, in UTF-8 bytes. */
export const maxResearchReportBytes = 200 * 1024;
/** A turn id that may name a report file. */
export const researchTurnIdPattern = /^[A-Za-z0-9_-]{1,100}$/;

/** Why Research can't be turned on or used; undefined when it can. */
export type ResearchUnavailable =
  "policy" | "mode" | "incognito" | "service" | "model";

export const researchUnavailableMessages: Record<ResearchUnavailable, string> =
  {
    policy: "Your administrator has turned off Research.",
    mode: "Research isn't available for this session.",
    incognito: "Research isn't available in incognito chats.",
    service: "Research requires a Responses-compatible model service.",
    model: "Research isn't available for this model.",
  };

/** Enabled MCP integrations count as Research sources. */
export function researchConnectorEnabled(
  settings: Pick<Settings, "mcpServers">,
  policy: ClientPolicy,
  overrides: Record<string, boolean> = {},
) {
  return Object.entries(settings.mcpServers ?? {}).some(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const server = value as Record<string, unknown>;
    return (
      (overrides[name] ?? server.enabled !== false) &&
      connectorAllowed(policy, name, value) &&
      !(
        Array.isArray(server.enabled_tools) && server.enabled_tools.length === 0
      )
    );
  });
}

/**
 * Whether Research can run for a conversation (or a new Chat) with this
 * model: the administrator allows Research and web search, the conversation
 * is a Chat that is not incognito, the model service speaks the Responses
 * protocol and supports web search, or an enabled connector supplies sources.
 */
export function researchUnavailable(input: {
  policy: Pick<ClientPolicy, "webSearch" | "research">;
  mode: Mode;
  incognito?: boolean;
  provider?: Pick<Provider, "protocol" | "routes">;
  /** The selected model: with several service groups, its group's protocol counts (MG). */
  model?: string;
  catalogItem?: Pick<ModelCatalogItem, "webSearch">;
  searchIntegrationEnabled?: boolean;
}): ResearchUnavailable | undefined {
  if (!input.policy.webSearch || !researchPolicyOf(input.policy).enabled)
    return "policy";
  if (input.mode !== "chat") return "mode";
  if (input.incognito) return "incognito";
  if (input.searchIntegrationEnabled) return undefined;
  if (
    !input.provider ||
    modelProtocol(input.provider, input.model) !== "responses"
  )
    return "service";
  if (input.catalogItem?.webSearch === "none") return "model";
  return undefined;
}

/** A conversation whose earlier turns ran in Research mode. */
export const hadResearch = (conversation: Pick<Conversation, "turns">) =>
  conversation.turns.some((turn) => !!turn.research);

/** A page's address without its fragment, for counting distinct pages. */
export function sourceKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** Every distinct page a turn's searches returned or its replies cited. */
export function turnSourceUrls(turn: Pick<Turn, "items">): Set<string> {
  const urls = new Set<string>();
  const add = (url: unknown) => {
    const key = typeof url === "string" ? sourceKey(url) : undefined;
    if (key) urls.add(key);
  };
  for (const item of turn.items) {
    if (Array.isArray(item.sources))
      for (const source of item.sources) add(source?.url);
    if (Array.isArray(item.citations))
      for (const citation of item.citations) add(citation?.url);
    if (Array.isArray(item.webCitations))
      for (const url of item.webCitations) add(url);
  }
  return urls;
}

/** Milliseconds a Research turn has run (until `now` while it runs). */
export function researchElapsed(state: ResearchState, now = Date.now()) {
  const end = researchFinished(state) ? (state.completedAt ?? now) : now;
  return Math.max(0, end - state.startedAt);
}

/** "46s", "2m 58s", "1h 4m": the Research card's clock. */
export function formatResearchElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A report title from its Markdown: the first level-one heading, if any. */
export function reportHeading(markdown: string): string | undefined {
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return cleanResearchTitle(match[1]);
  }
  return undefined;
}

/** A title on one line, without control characters, at most the title limit. */
export function cleanResearchTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return;
  const points = Array.from(text);
  return points.length > maxResearchTitleLength
    ? points.slice(0, maxResearchTitleLength).join("")
    : text;
}

/** A file name for a saved report: the title without characters file systems refuse. */
export function reportFileName(title: string | undefined) {
  const base = (title ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100);
  return `${base || "Research report"}.md`;
}
