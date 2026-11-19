import type { CommandDeclineCard } from "../command-decline-host";

/** Exact fields and enum numbers from the pinned 4.4212.0 conversation protocol. */
export function commandDeclineElicitations(
  cards: readonly CommandDeclineCard[],
  pageConversationId: string,
) {
  return cards.map((card, index) => ({
    id: card.elicitationId,
    conversationId: pageConversationId,
    index,
    request: {
      status: 1, // STATUS_PENDING, including an unknown result: never synthesize a decline.
      kind: 1, // KIND_APPROVAL
      title: "Command request",
      description:
        card.state === "unconfirmed"
          ? "The decline result is unconfirmed. It will not be sent again. Reopen the conversation to check its current state."
          : "You can decline this command here. Approval is not supported in this interface.",
      descriptionFormat: { style: 2 }, // MARKDOWN enables the original served approval card.
      askNonce: card.askNonce,
      holdsConversation: true,
      acceptsTypedAnswer: true,
      requiresUserInteraction: true,
      requester: { kind: 2 }, // ASSISTANT
      reportedAction: {
        toolName: "Bash",
        toolInput: JSON.stringify({ command: card.command }),
      },
      fields: [
        {
          name: "decision",
          type: 1,
          label: "Decision",
          options: [{ value: "deny", label: "Decline", isDeny: true }],
        },
      ],
    },
  }));
}
