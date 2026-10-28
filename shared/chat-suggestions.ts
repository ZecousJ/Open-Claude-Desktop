import type { Item } from "./types";

export const nextStepOffers = [
  "build_doc",
  "build_sheet",
  "make_deck",
  "write_brief",
  "draft_email",
  "make_task_list",
] as const;
export type NextStepOffer = (typeof nextStepOffers)[number];
export type NextStepScenario = "answer_to_work" | "next_after_completion";
export interface NextStepInput {
  offer: NextStepOffer;
  scenario: NextStepScenario;
}
export const capabilityTips = [
  "document_creation",
  "cowork",
  "file_uploads",
  "projects",
  "artifacts",
  "memory",
  "scheduled_tasks",
  "screenshots",
  "chat_history_search",
  "skills",
  "temporary_chat",
] as const;
export type ArtifactTip = (typeof capabilityTips)[number];
export type CapabilityTip = ArtifactTip;
export const suggestionTools = ["offer_next_step_v0", "suggest_capability"];

export function nextStepInput(value: unknown): NextStepInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (
    !Object.hasOwn(input, "offer") ||
    !Object.hasOwn(input, "scenario") ||
    !nextStepOffers.includes(input.offer as NextStepOffer) ||
    !["answer_to_work", "next_after_completion"].includes(
      input.scenario as string,
    )
  )
    return;
  return {
    offer: input.offer as NextStepOffer,
    scenario: input.scenario as NextStepScenario,
  };
}

export function suggestionItem(item: Item) {
  return (
    item.type === "dynamicToolCall" && suggestionTools.includes(item.tool ?? "")
  );
}

export interface NextStepPacing {
  shownFor?: string;
  shownToolUseId?: string;
  outcome: "ignored" | "clicked" | "dismissed";
  closed: boolean;
  open: Partial<Record<NextStepOffer, string>>;
}
export interface NextStepBackoff {
  closes: number[];
  pausedUntil: number;
}
export const emptyPacing = (): NextStepPacing => ({
  outcome: "ignored",
  closed: false,
  open: {},
});

// .
export function nextStepSuppressed(
  state: NextStepPacing,
  toolUseId: string,
  offer: NextStepOffer,
  humanTurnsSinceShown: number | undefined,
) {
  if (state.shownToolUseId === toolUseId) return false;
  if (
    state.closed ||
    (state.open[offer] !== undefined && state.open[offer] !== toolUseId)
  )
    return true;
  return (
    state.shownFor !== undefined &&
    humanTurnsSinceShown !== undefined &&
    humanTurnsSinceShown <=
      { clicked: 0, ignored: 3, dismissed: 10 }[state.outcome]
  );
}

export function dismissNextStep(
  state: NextStepBackoff,
  now: number,
): NextStepBackoff {
  const week = 7 * 86400000;
  const closes = [
    ...state.closes.filter((time) => time <= now && now - time < week),
    now,
  ];
  return closes.length >= 3
    ? { closes: [], pausedUntil: now + week }
    : { closes, pausedUntil: state.pausedUntil };
}

export interface ArtifactTipPacing {
  lastShownConversation?: string;
  lastCountedConversation?: string;
  sessionsSinceLastShow: number;
  ledger: Partial<
    Record<ArtifactTip, { count: number; lastSessionId: string }>
  >;
  dismissed: ArtifactTip[];
}
export const emptyTipPacing = (): ArtifactTipPacing => ({
  sessionsSinceLastShow: 0,
  ledger: {},
  dismissed: [],
});
export function tipAllowed(
  state: ArtifactTipPacing,
  tip: ArtifactTip,
  conversationId: string,
) {
  const entry = state.ledger[tip];
  const count = entry
    ? entry.count - (entry.lastSessionId === conversationId ? 1 : 0)
    : 0;
  return (
    count < 3 &&
    !state.dismissed.includes(tip) &&
    (!state.lastShownConversation ||
      state.lastShownConversation === conversationId ||
      state.sessionsSinceLastShow >= 3)
  );
}
