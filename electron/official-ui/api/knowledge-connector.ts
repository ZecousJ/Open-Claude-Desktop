import {
  HUANER_TECH,
  HIWONDER_KNOWLEDGE_SERVER,
  HIWONDER_KNOWLEDGE_TOOLS,
  hiwonderKnowledgeRelayUrl,
  type KnowledgeBaseInfo,
} from "../../../shared/knowledge-api";
import type { McpServerState, McpToolState } from "../../../shared/settings-desktop-api";
import type { AdapterContext } from "./context";

export const knowledgeConnectorName = HIWONDER_KNOWLEDGE_SERVER;
const [search, read] = HIWONDER_KNOWLEDGE_TOOLS;

export const knowledgeConnectorTools: readonly McpToolState[] = [
  {
    name: search,
    description: "Search the knowledge base for product manuals, course materials and source code.",
    enabled: false,
    access: "readOnly",
    approval: "approve",
    definition: {
      name: search,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          top_k: { type: "integer", default: 10 },
          path_prefix: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
          source_only: { type: "boolean", default: false },
        },
        required: ["query"],
      },
    },
  },
  {
    name: read,
    description: "Read a document or source file at a path returned by knowledge base search.",
    enabled: false,
    access: "readOnly",
    approval: "approve",
    definition: {
      name: read,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", default: 0 },
          limit: { type: "integer", default: 20000 },
        },
        required: ["path"],
      },
    },
  },
];

export interface KnowledgeConnector {
  base: KnowledgeBaseInfo;
  server: McpServerState;
}

export async function knowledgeConnector(
  ctx: Pick<AdapterContext, "knowledgeOffer" | "connectorAlwaysAllow">,
): Promise<KnowledgeConnector | undefined> {
  const offer = await ctx.knowledgeOffer?.().catch(() => undefined);
  const base = offer?.bases.find((entry) => entry.id === HUANER_TECH);
  if (!offer || !base) return undefined;
  const url = hiwonderKnowledgeRelayUrl(offer.baseUrl);
  const approval = ctx.connectorAlwaysAllow?.() === false ? "prompt" : "approve";
  return {
    base,
    server: {
      name: knowledgeConnectorName,
      displayName: base.name,
      url,
      transport: "streamable-http",
      state: base.available ? "ready" : "failed",
      tools: knowledgeConnectorTools.length,
      toolList: knowledgeConnectorTools.map((tool) => ({ ...tool, approval })),
    },
  };
}
