import type { EngineExtension } from "./engine-extensions";
import {
  capabilityTips,
  nextStepInput,
  nextStepOffers,
  suggestionTools,
} from "../../shared/chat-suggestions";

export function chatSuggestionsExtension(): EngineExtension {
  return {
    id: "chat-suggestions",
    developerInstructions: ({ mode }) =>
      mode === "chat"
        ? "After a complete useful answer, you may call offer_next_step_v0 to suggest one useful document, spreadsheet, slide deck, brief, email or task list. Call it last, with no text afterwards; do not offer work already requested or completed. Alternatively suggest_capability can suggest one relevant Claudex feature such as projects, scheduled tasks, memory, skills, Cowork, chat history search, screenshots, file uploads, artifacts or document creation. These tools only display suggestions; they do not create files. Only offer when relevant, never on every reply."
        : undefined,
    dynamicTools: ({ mode }) =>
      mode !== "chat"
        ? []
        : [
            {
              type: "function",
              name: "offer_next_step_v0",
              description:
                "Offer one useful next step after a complete answer. Must be the final call with no text afterwards.",
              inputSchema: {
                type: "object",
                properties: {
                  offer: { type: "string", enum: [...nextStepOffers] },
                  scenario: {
                    type: "string",
                    enum: ["answer_to_work", "next_after_completion"],
                  },
                },
                required: ["offer", "scenario"],
                additionalProperties: false,
              },
            },
            {
              type: "function",
              name: "suggest_capability",
              description:
                "Suggest one relevant Claudex feature after a complete useful answer. Call last without further text; never suggest a feature already used in this chat.",
              inputSchema: {
                type: "object",
                properties: {
                  feature: {
                    type: "string",
                    enum: [...capabilityTips],
                  },
                },
                required: ["feature"],
                additionalProperties: false,
              },
            },
          ],
    handleDynamicTool(call) {
      if (call.namespace || !suggestionTools.includes(call.tool)) return;
      const tip = (call.arguments as { feature?: unknown } | null)?.feature;
      const valid =
        call.conversation.mode === "chat" &&
        (call.tool === "offer_next_step_v0"
          ? !!nextStepInput(call.arguments)
          : typeof tip === "string" &&
            capabilityTips.includes(tip as (typeof capabilityTips)[number]));
      return {
        success: valid,
        contentItems: [
          {
            type: "inputText",
            text: valid
              ? call.tool === "suggest_capability"
                ? JSON.stringify({ suggest: true, feature: tip, tier: 2 })
                : "Suggestion recorded. End the reply now without further text."
              : "Invalid suggestion.",
          },
        ],
      };
    },
  };
}
