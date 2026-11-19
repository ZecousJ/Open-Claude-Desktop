import type { Conversation, Settings } from "../../../shared/types";
import { HIWONDER_KNOWLEDGE_SERVER, hiwonderKnowledgeEnabled } from "../../../shared/knowledge-api";
import { connectorUuid } from "./connectors";
import type { KnowledgeConnector } from "./knowledge-connector";

interface CloudCodeConnector {
  key: string;
  name: string;
  url: string;
}

export function cloudCodeConnectorInventory(config: Settings["mcpServers"], knowledge?: KnowledgeConnector) {
  const inventory: CloudCodeConnector[] = [];
  for (const [key, server] of Object.entries(config ?? {})) {
    if (
      key === HIWONDER_KNOWLEDGE_SERVER ||
      !server ||
      typeof server !== "object" ||
      !("url" in server) ||
      typeof server.url !== "string" ||
      !server.url ||
      ("command" in server && server.command) ||
      ("enabled" in server && server.enabled === false)
    )
      continue;
    const name =
      "display_name" in server && typeof server.display_name === "string"
        ? server.display_name || key
        : key;
    inventory.push({ key, name, url: server.url });
  }
  if (knowledge?.base.available && knowledge.server.url)
    inventory.push({ key: HIWONDER_KNOWLEDGE_SERVER, name: knowledge.base.name, url: knowledge.server.url });
  return inventory;
}

export function cloudCodeMcpConfig(
  conversation: Pick<Conversation, "connectorOverrides" | "knowledgeBases">,
  inventory: readonly CloudCodeConnector[],
) {
  return {
    mcpServers: Object.fromEntries(
      inventory
        .filter(
          (server) => server.key === HIWONDER_KNOWLEDGE_SERVER
            ? hiwonderKnowledgeEnabled(conversation)
            : conversation.connectorOverrides?.[server.key] !== false,
        )
        .map((server) => {
          const uuid = connectorUuid(server.key);
          return [
            uuid,
            {
              type: "http",
              url: server.url,
              headers: { "X-MCP-Server-ID": uuid },
            },
          ];
        }),
    ),
  };
}
