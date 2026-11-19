import type { Conversation, Item, Settings } from "./types";
import { preference } from "./settings-extras";

/** Only provider-issued public summary sections are displayable, never raw content. */
export function visibleThinkingSummary(item: Pick<Item, "summary">): string[] {
  return Array.isArray(item.summary)
    ? item.summary.filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      )
    : [];
}

/** ccd_thinking_summary_on_demand (live claude.ai bundle, 2026-10-14,
 * c1c1ec7b9-DdxFmCQ2.js; desktop 2.37337.1, index.chunk-BolytlRP.js). */
export function onDemandThinking(
  conversation: Conversation,
  settings: Settings,
) {
  return (
    preference(settings, "ccdThinkingSummaryOnDemand") &&
    conversation.mode === "code" &&
    !conversation.cloudHosted &&
    !conversation.cloudEnvironmentId &&
    (!conversation.environment ||
      conversation.environment.kind === "local" ||
      conversation.environment.kind === "ssh")
  );
}

export function thinkingSummaryForTurn(
  conversation: Conversation,
  settings: Settings,
  supportsCloudSummary = false,
) {
  if (
    supportsCloudSummary &&
    conversation.mode === "code" &&
    conversation.environment?.kind === "space" &&
    !conversation.cloudHosted
  )
    return { summary: "auto" as const };
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
          item.type === "reasoning" && visibleThinkingSummary(item).length > 0,
      ),
    )
  );
}
