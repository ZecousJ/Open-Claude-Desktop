import type { Conversation } from "./types";

export type BrowserExecutionConversation = Pick<
  Conversation,
  | "mode"
  | "environment"
  | "linkedToComputer"
  | "chatDeviceBinding"
  | "deviceChatOrigin"
  | "cloudHosted"
  | "cloudEnvironmentId"
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
    !conversation.cloudHosted &&
    !conversation.cloudEnvironmentId &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    conversation.deviceChatOrigin?.active !== false
  );
}

export function hasOffHostCodeBrowser(
  conversation: BrowserExecutionConversation | undefined,
): boolean {
  return (
    conversation?.mode === "code" &&
    (conversation.environment?.kind === "ssh" ||
      conversation.environment?.kind === "wsl") &&
    !conversation.cloudHosted &&
    !conversation.cloudEnvironmentId &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    !conversation.deviceChatOrigin
  );
}
