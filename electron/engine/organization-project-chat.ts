import { AsyncLocalStorage } from "node:async_hooks";
import type { Conversation } from "../../shared/types";

export interface OrganizationProjectBinding {
  projectOrganizationId: string;
  projectId: string;
}

export interface OrganizationProjectChat extends OrganizationProjectBinding {
  conversationId: string;
  load(prompt: string): Promise<{ instructions: string; knowledge: string }>;
}

export const organizationProjectChat = new AsyncLocalStorage<OrganizationProjectChat>();

export function organizationProjectChatFor(
  conversation: Conversation | undefined,
  newId: string | undefined,
  mode: Conversation["mode"],
) {
  const authority = organizationProjectChat.getStore();
  if (!authority || authority.conversationId !== (conversation?.id ?? newId) || mode !== "chat") {
    if (!conversation?.projectOrganizationId) return undefined;
    throw Error("Open the shared project to continue this conversation.");
  }
  if (conversation && (
    conversation.projectId !== authority.projectId ||
    conversation.projectOrganizationId !== authority.projectOrganizationId
  )) throw Error("This conversation's project changed. Reopen it before sending.");
  return authority;
}
