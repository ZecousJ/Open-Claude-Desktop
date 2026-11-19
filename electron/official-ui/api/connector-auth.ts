import { createHash } from "node:crypto";
import type { Conversation, Item } from "../../../shared/types";
import { rejectedConnectorTool } from "../../connectors/connector-auth-rejection";

export function connectorUuid(name: string) {
  const hex = createHash("sha256")
    .update("claudex-connector:" + name)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface McpAuthRequired {
  server_id: string;
  tool_use_id: string;
  error_code: "mcp_auth_required";
  conversation_uuid?: string;
}

export function mcpAuthRequired(
  item: Item,
  toolUseId: string,
  conversationId?: string,
): McpAuthRequired | undefined {
  const server = rejectedConnectorTool(item);
  if (!server) return;
  return {
    server_id: connectorUuid(server),
    tool_use_id: toolUseId,
    error_code: "mcp_auth_required",
    ...(conversationId && { conversation_uuid: conversationId }),
  };
}

export function matchesConnectorAuthRejection(
  conversation: Conversation | undefined,
  serverName: string,
  serverUrl: string,
  toolUseId: string,
) {
  const branches = [
    conversation?.turns ?? [],
    ...(conversation?.savedBranches ?? []).map((branch) => branch.turns),
  ];
  return branches.some((turns) =>
    turns.some((turn) =>
      turn.items.some(
        (item) =>
          item.mcpAuthRejectionUrl === serverUrl &&
          item.server === serverName &&
          toolUseId ===
            (conversation?.mode === "code" || conversation?.mode === "cowork"
              ? `${turn.id}:tool:${item.id}`
              : `${turn.id}:${item.id}`) &&
          mcpAuthRequired(item, toolUseId) !== undefined,
      ),
    ),
  );
}
