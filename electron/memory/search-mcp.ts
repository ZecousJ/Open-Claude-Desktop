import { randomBytes } from "node:crypto";
import type { Conversation } from "../../shared/types";
import { BrowserMcpServer } from "../browser/mcp-server";
import type { BuiltinMcpServer } from "../engine/engine-extensions";
import type { ChatSearchIndex } from "./chat-search";
import { memoryApplies, searchScopeOf } from "./inject";
import type { MemoryService } from "./service";
import {
  conversationSearchTool,
  pastChatSearchTools,
  recentChatsTool,
  runConversationSearch,
  runRecentChats,
} from "./tools";

const name = "claudex_chat_history";
const mcpTools = pastChatSearchTools.map(
  ({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }),
);

export function startMemorySearch(deps: {
  service: () => MemoryService | undefined;
  conversation: (id: string) => Conversation | undefined;
  index: ChatSearchIndex;
}) {
  const token = randomBytes(32).toString("base64url");
  const server = new BrowserMcpServer({
    token,
    serverName: name,
    handlers: {
      tools(id) {
        const conversation = deps.conversation(id);
        return conversation &&
          memoryApplies(conversation, conversation.mode) &&
          deps.service()?.effective().searchChats
          ? mcpTools
          : [];
      },
      async call(tool, args, { conversationId }) {
        const conversation = deps.conversation(conversationId);
        const service = deps.service();
        if (
          !conversation ||
          !service ||
          !memoryApplies(conversation, conversation.mode) ||
          (tool !== conversationSearchTool && tool !== recentChatsTool)
        )
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Past chats aren't available in this chat.",
              },
            ],
          };
        const search =
          tool === conversationSearchTool
            ? runConversationSearch
            : runRecentChats;
        const result = search(
          service,
          deps.index,
          searchScopeOf(conversation),
          args,
        );
        return {
          isError: !result.success,
          content: [{ type: "text", text: result.text }],
        };
      },
    },
  });
  const ready = server.start().catch((error) => {
    console.error("Chat history search could not be started:", error);
  });
  return {
    name,
    bridge: { name, ready, port: () => server.port },
    forConversation(id: string): BuiltinMcpServer | undefined {
      const url = server.url(id);
      return url
        ? {
            name,
            url,
            enabled: true,
            httpHeaders: { Authorization: `Bearer ${token}` },
            defaultToolsApprovalMode: "approve",
          }
        : undefined;
    },
    async close() {
      await ready;
      await server.close();
    },
  };
}
