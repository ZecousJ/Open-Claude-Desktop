/**
 * Knowledge bases (owner, 2026-10-07: ZecousAI's Hiwonder knowledge base,
 * offered to every account, off until a chat turns it on). The service lists
 * them (GET /api/v1/claudex/knowledge) and relays the agent's MCP requests to
 * each base's server (/v1/claudex/knowledge/<id>/mcp, through the app's local
 * gateway, which adds the account's key). New sessions use connector
 * preferences, with `knowledgeBases` as the fallback for existing sessions.
 */
import { bridgeMethods } from "./bridge-methods";
import type { ClientPolicy } from "./client-policy";
import { connectorAllowed } from "./client-policy-rules";
import type { Conversation } from "./types";

export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  description: string;
  /** Whether the base's server answers now. */
  available: boolean;
}

export interface KnowledgeAPI {
  /** The bases the service offers; empty without a Claudex service. */
  knowledgeBases(): Promise<KnowledgeBaseInfo[]>;
}

export const knowledgeMethods = bridgeMethods<KnowledgeAPI>({
  knowledgeBases: true,
});

/** The address under /api/v1. */
export const knowledgePath = "/claudex/knowledge";

export const knowledgeBaseId = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Hiwonder's base, the one ZecousAI offered (the agent serves only it for now). */
export const HUANER_TECH = "huaner-tech";

/** Most bases one conversation uses. */
export const maxConversationBases = 8;

/** The service's answer (Sub2API envelope or bare), checked. */
export function knowledgeBasesFrom(raw: unknown): KnowledgeBaseInfo[] {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const data = (
    typeof outer.code === "number" && "data" in outer ? outer.data : outer
  ) as { bases?: unknown } | null;
  const list = Array.isArray(data?.bases) ? data.bases : [];
  const out: KnowledgeBaseInfo[] = [];
  for (const item of list.slice(0, maxConversationBases)) {
    const b = (item ?? {}) as Record<string, unknown>;
    if (typeof b.id !== "string" || !knowledgeBaseId.test(b.id)) continue;
    if (typeof b.name !== "string" || !b.name.trim()) continue;
    out.push({
      id: b.id,
      name: b.name.trim().slice(0, 60),
      description:
        typeof b.description === "string" ? b.description.slice(0, 200) : "",
      available: b.available === true,
    });
  }
  return out;
}

/** The ids a conversation may name: valid, unique, at most eight. */
export function cleanBaseIds(ids: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const id of ids ?? [])
    if (typeof id === "string" && knowledgeBaseId.test(id) && !out.includes(id))
      out.push(id);
  return out.slice(0, maxConversationBases);
}

/** The local gateway route of a base's MCP relay (electron/gateway.ts). */
export const knowledgeRoute = (id: string) => `/v1/claudex/knowledge/${id}/mcp`;
export const knowledgeRoutePattern =
  /^\/v1\/claudex\/knowledge\/([a-z0-9][a-z0-9-]{0,63})\/mcp$/;

/** The Codex MCP server name of a base (reserved by the knowledge extension). */
export const knowledgeServerName = (id: string) =>
  `knowledge_${id.replace(/-/g, "_")}`;

export const HIWONDER_KNOWLEDGE_SERVER = knowledgeServerName(HUANER_TECH);
export const HIWONDER_KNOWLEDGE_TOOLS = ["rag_search", "rag_read"] as const;

export function hiwonderKnowledgeEnabled(
  conversation: Pick<Conversation, "connectorOverrides" | "knowledgeBases">,
): boolean {
  return (
    conversation.connectorOverrides?.[HIWONDER_KNOWLEDGE_SERVER] ??
    conversation.knowledgeBases?.includes(HUANER_TECH) ??
    false
  );
}

export function hiwonderKnowledgeRelayUrl(serviceBaseUrl: string): string {
  const base = `${serviceBaseUrl.replace(/\/+$/, "")}/`;
  return new URL(`.${knowledgeRoute(HUANER_TECH)}`, base).href;
}

export function hiwonderKnowledgeAllowed(
  policy: ClientPolicy,
  serviceBaseUrl: string,
): boolean {
  return connectorAllowed(policy, HIWONDER_KNOWLEDGE_SERVER, {
    url: hiwonderKnowledgeRelayUrl(serviceBaseUrl),
  });
}

/**
 * How the agent uses a knowledge base (ZecousAI's knowledge workflow, its
 * tools rag_search and rag_read served by the base's MCP server).
 */
export function knowledgeInstructions(
  names: string[],
  tools: readonly (typeof HIWONDER_KNOWLEDGE_TOOLS)[number][] = HIWONDER_KNOWLEDGE_TOOLS,
) {
  const search = tools.includes("rag_search");
  const read = tools.includes("rag_read");
  if (!search && !read) return undefined;
  return [
    "# Knowledge Retrieval Workflow",
    `Knowledge bases selected in this session: ${names.join(", ")}. They hold the authoritative manuals, course materials, and source code for the user's robot and hardware products. Use their available tools: ${tools.join(", ")}.`,
    ...(search
      ? [
          "Call rag_search at the start of tasks about specific robots, models, boards, courses, code, configuration, calibration, or debugging. Robot coding tasks include line-following, obstacle avoidance, motor control, PID tuning, wiring, and sensors.",
          "Start with broad product, model, version, or course keywords to find the relevant directory. Include English terms for likely English code symbols or paths.",
          "Reuse a directory returned by a tool as path_prefix for further searches. For code or debugging, search inside it with source_only=true and likely English code terms. If the focused search is empty, broaden path_prefix by one level or retry without source_only.",
        ]
      : []),
    ...(read
      ? [
          search
            ? "Use rag_read on relevant documents and source files returned by rag_search before making specific implementation claims or writing code."
            : "Use rag_read when the user or the conversation provides the path to a relevant document or source file. Ask for the path if needed.",
        ]
      : []),
    "",
    "# Knowledge Source Paths",
    "When you cite or mention source paths from knowledge-base search/read results, format the visible path from the product folder onward. Do not show root or category folders such as `知识库/11.强化学习/`. Remove leading numbering prefixes from the product folder, such as `1.`, `01.`, `1、`, or `01、`.",
    "When the visible source/reference path ends with `.txt`, omit that suffix in the final answer. Keep other file extensions such as `.md`, `.py`, or `.ts` unchanged.",
    "Example: show `SO-ARM101开源6轴机械臂/2.软件工具&源码程序/源码程序/lerobot_源码/lerobot/README.md` instead of `知识库/11.强化学习/1.SO-ARM101开源6轴机械臂/2.软件工具&源码程序/源码程序/lerobot_源码/lerobot/README.md`.",
    "If you answer in any language other than Chinese, render user-visible source/reference paths entirely in English, translating Chinese folder and file names; keep brand/model/code tokens, package names, and file extensions unchanged.",
    "Do not rewrite tool input paths; this rule only applies to user-visible source or reference text.",
  ].join("\n");
}
