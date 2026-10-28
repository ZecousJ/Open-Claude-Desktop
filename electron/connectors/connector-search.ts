import { preference } from "../../shared/settings-extras";
import type { Settings } from "../../shared/types";
import { connectors } from "../../shared/connectors-catalogue";
import type { EngineExtension } from "../engine/engine-extensions";

// Connector suggestions are on unless explicitly disabled.
export function connectorSearchExtension(
  settings: () => Settings,
): EngineExtension {
  return {
    id: "connector-search",
    incognito: true,
    // A thread keeps the tools it started with: the tool stays, and each
    // turn's context says whether it may be used now.
    dynamicTools: (ctx) =>
      ctx.mode === "chat"
        ? [
            {
              type: "function",
              name: "search_connector_directory",
              description:
                "Find connectors relevant to the conversation. Return directory links the user can open to connect a tool. This does not grant access to a connector.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
          ]
        : [],
    turnContext: (ctx) =>
      ctx.mode === "chat"
        ? {
            connector_search: preference(ctx.settings, "connectorSearch")
              ? "When a connector would help, search_connector_directory can find relevant connectors. Show relevant directory links; never claim an unconnected tool is connected."
              : "Connector suggestions are disabled. Do not call search_connector_directory or suggest connecting tools.",
          }
        : undefined,
    handleDynamicTool(call) {
      if (call.namespace || call.tool !== "search_connector_directory") return;
      const query = (call.arguments as { query?: unknown } | null)?.query;
      const enabled =
        call.conversation.mode === "chat" &&
        preference(settings(), "connectorSearch");
      const words =
        typeof query === "string"
          ? query.trim().toLowerCase().split(/\s+/).filter(Boolean)
          : [];
      return {
        success: enabled && words.length > 0,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify(
              enabled && words.length
                ? connectors
                    .filter((entry) =>
                      words.some((word) =>
                        `${entry.name} ${entry.description} ${entry.topic}`
                          .toLowerCase()
                          .includes(word),
                      ),
                    )
                    .slice(0, 6)
                    .map((entry) => ({
                      name: entry.name,
                      description: entry.description,
                      url: `/settings/connectors?connector=${encodeURIComponent(entry.id)}`,
                    }))
                : [],
            ),
          },
        ],
      };
    },
  };
}
