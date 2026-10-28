import type { Conversation } from "../../shared/types";

/** Issue order and conditions. */
export const negativeCategories = [
  { id: "ui_bug", label: "UI bug" },
  { id: "overactive_refusal", label: "Overactive refusal" },
  {
    id: "did_not_follow_instructions",
    label: "Did not fully follow my request",
  },
  { id: "not_factually_correct", label: "Not factually correct" },
  { id: "incomplete_response", label: "Incomplete response" },
  { id: "harmful_content", label: "Report content" },
  { id: "other", label: "Other" },
] as const;

export function feedbackCategoriesFor({
  conversation,
  turnId,
  memoryAvailable = false,
  webSearchAvailable = false,
}: {
  conversation?: Conversation;
  turnId: string;
  memoryAvailable?: boolean;
  webSearchAvailable?: boolean;
}) {
  const index =
    conversation?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
  const turns = index < 0 ? [] : conversation!.turns.slice(0, index + 1);
  const items = turns.at(-1)?.items ?? [];
  const searched = items.some(
    (item) =>
      item.type === "webSearch" &&
      !["openPage", "findInPage"].includes(item.action?.type),
  );
  return [
    ...negativeCategories.slice(0, 2),
    ...(turns.some((turn) =>
      turn.attachments.some((file) => file.kind === "image"),
    )
      ? [{ id: "file", label: "Poor image understanding" }]
      : []),
    ...negativeCategories.slice(2, 5),
    items.some((item) => item.type === "reasoning")
      ? { id: "thoughts", label: "Issue with thought process" }
      : { id: "think_under", label: "Should have triggered thinking" },
    ...(searched
      ? [
          { id: "web_over", label: "Shouldn’t have searched the web" },
          { id: "web_sources", label: "Don’t like the cited sources" },
          { id: "web_url", label: "Report a URL" },
        ]
      : webSearchAvailable && conversation?.webSearch
        ? [{ id: "web_under", label: "Should have searched the web" }]
        : []),
    ...(memoryAvailable ? [{ id: "memory", label: "Issue with memory" }] : []),
    negativeCategories[5],
    { id: "constitution", label: "Not in keeping with Claudex’s Constitution" },
    negativeCategories[6],
  ];
}
