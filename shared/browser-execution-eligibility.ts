import type { Conversation } from "./types";

export type BrowserExecutionConversation = Pick<
  Conversation,
  | "mode"
  | "environment"
  | "linkedToComputer"
  | "chatDeviceBinding"
  | "deviceChatOrigin"
>;

/** The native browser belongs to the machine executing this conversation.
 * Cloud/SSH records and logical mirrors of another computer cannot use it.
 * Device execution replicas are local records, distinct from those mirrors. */
export function hasLocalBrowserExecution(
  conversation: BrowserExecutionConversation | undefined,
): boolean {
  return (
    !!conversation &&
    (conversation.mode === "code" || conversation.mode === "cowork") &&
    (!conversation.environment || conversation.environment.kind === "local") &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    conversation.deviceChatOrigin?.active !== false
  );
}
