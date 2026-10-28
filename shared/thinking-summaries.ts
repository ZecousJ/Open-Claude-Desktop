import type { Conversation, Settings } from "./types";
import { preference } from "./settings-extras";

/** ccd_thinking_summary_on_demand. */
export function onDemandThinking(
  conversation: Conversation,
  settings: Settings,
) {
  return (
    preference(settings, "ccdThinkingSummaryOnDemand") &&
    conversation.mode === "code" &&
    (!conversation.environment || conversation.environment.kind === "local")
  );
}

export function thinkingSummaryForTurn(
  conversation: Conversation,
  settings: Settings,
) {
  return onDemandThinking(conversation, settings)
    ? {
        summary:
          conversation.thinkingSummariesWanted === true
            ? ("auto" as const)
            : ("none" as const),
      }
    : {};
}

export function thinkingSummariesNotice(
  conversation: Conversation,
  settings: Settings,
  visible: boolean,
) {
  return (
    onDemandThinking(conversation, settings) &&
    visible &&
    conversation.turns.length > 0 &&
    !conversation.turns.some((turn) =>
      turn.items.some(
        (item) =>
          item.type === "reasoning" &&
          item.summary?.some((text) => text.trim().length > 0),
      ),
    )
  );
}
