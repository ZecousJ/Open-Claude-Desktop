import type { McpServerState } from "../../shared/settings-desktop-api";
import type { ConversationToolOverrides } from "../../shared/conversation-tools";

/** O16 c752b32f8:2450–2510: the connector checkbox represents its
 * session-effective tools, while connection/authentication remains separate. */
export function connectorSessionEnabled(
  name: string,
  configured: boolean,
  serverOverride: boolean | undefined,
  tools: ConversationToolOverrides | undefined,
  status: McpServerState | undefined,
) {
  if ((serverOverride ?? configured) === false) return false;
  if (!status?.toolList?.length) return true;
  return status.toolList.some(
    (tool) => tool.enabled && tools?.[name]?.[tool.name] !== false,
  );
}

/** Only the host's known eligible tools are selected. Global disabled tools
 * and approval modes are never cleared by the conversation's enable action. */
export function connectorSessionPatch(
  status: McpServerState | undefined,
  enabled: boolean,
): ConversationToolOverrides {
  if (!status) return {};
  const tools = Object.fromEntries(
    (status.toolList ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => [tool.name, enabled]),
  );
  return Object.keys(tools).length ? { [status.name]: tools } : {};
}
