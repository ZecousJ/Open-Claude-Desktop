import type { AppEvent, Conversation } from "../../shared/types";

/** Internal observers retain real runtime events; public UI/cloud projections
 * display only their separately confirmed logical conversation. */
export function emitPrivateDeviceEvent(
  event: AppEvent,
  conversations: readonly Conversation[],
  internal: (event: AppEvent) => void,
) {
  const id =
    event.type === "conversation"
      ? event.conversation.id
      : event.type === "approval"
        ? event.approval.conversationId
        : "conversationId" in event && typeof event.conversationId === "string"
          ? event.conversationId
          : undefined;
  const privateCopy =
    (event.type === "conversation" && event.conversation.deviceChatOrigin) ||
    (id && conversations.find((c) => c.id === id)?.deviceChatOrigin);
  if (!privateCopy) return false;
  internal(event);
  return true;
}
