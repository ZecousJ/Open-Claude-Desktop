import { workspaceRepository } from "../git/git-branch";
import type {
  ShareAccess,
  SharedChatReport,
  ShareInviteResult,
  ShareInviteOptions,
} from "../../shared/sharing-api";
import {
  buildConversationSnapshot,
  lastSharedTurn,
} from "../conversations/conversation-snapshot";
import { unavailableMessage, sourceKeyOf } from "./hosted-shares-support";
import type { HostedShares } from "./hosted-shares";

// ---- conversations

/** The conversation's link (active or taken down), or null. */
export async function conversationShare(
  this: HostedShares,
  conversationId: string,
) {
  if (!(await this.status())) return null;
  await this.list("conversation");
  const share = this.cachedFor("conversation", conversationId);
  return share ? this.present(share) : null;
}

/** Shares the conversation's current branch, or refreshes its link's snapshot. */
export async function shareConversation(
  this: HostedShares,
  conversationId: string,
  access: ShareAccess = "link",
) {
  const status = await this.allowed("conversation");
  const conversation = this.options.conversation(conversationId);
  if (!conversation) throw new Error("Conversation not found.");
  const snapshot = buildConversationSnapshot(conversation, status);
  if (
    conversation.mode === "code" &&
    conversation.cwd &&
    (!conversation.environment || conversation.environment.kind === "local")
  ) {
    const repository = workspaceRepository(conversation.cwd);
    if (repository)
      snapshot.repositories = [
        ...new Set([...(snapshot.repositories ?? []), repository]),
      ];
  }
  const key = sourceKeyOf("conversation", conversationId);
  const share = await this.options.service.create({
    kind: "conversation",
    source_key: key,
    title: snapshot.title,
    snapshot,
    ...(access === "invited" ? { access } : {}),
  });
  const turn = lastSharedTurn(conversation);
  this.remember(key, {
    kind: "conversation",
    source: conversationId,
    ...(turn ? { turn } : {}),
  });
  this.store(share);
  this.options.changed("conversation", conversationId);
  return this.present(share);
}

/**
 * Switches the conversation's share between the public link and invited
 * people only. Without a share, the link makes one; invited people only
 * has nothing to switch yet.
 */
export async function setShareAccess(
  this: HostedShares,
  conversationId: string,
  access: ShareAccess,
) {
  await this.allowed("conversation");
  await this.list("conversation");
  const share = this.cachedFor("conversation", conversationId);
  if (!share)
    return access === "link"
      ? this.shareConversation(conversationId, "link")
      : null;
  if ((share.access ?? "link") === access) return this.present(share);
  // Nobody invited and no public link is no share at all.
  if (access === "invited" && !share.invites?.length) {
    await this.unshareConversation(conversationId);
    return null;
  }
  const updated = await this.options.service.setAccess(share.id, access);
  this.store(updated);
  this.options.changed("conversation", conversationId);
  return this.present(updated);
}

/** Invites an address; the conversation is shared to invited people only first when it has no share. */
export async function inviteToShare(
  this: HostedShares,
  conversationId: string,
  email: string,
): Promise<ShareInviteResult> {
  await this.allowed("conversation");
  await this.list("conversation");
  const share =
    this.cachedFor("conversation", conversationId) ??
    (await this.shareConversation(conversationId, "invited"));
  const result = await this.options.service.invite(share.id, email);
  this.store(result.share);
  this.options.changed("conversation", conversationId);
  return { ...result, share: this.present(result.share) };
}

/** Takes an address off; an invited-only share left with nobody stops. */
export async function removeShareInvite(
  this: HostedShares,
  conversationId: string,
  email: string,
) {
  await this.list("conversation");
  const share = this.cachedFor("conversation", conversationId);
  if (!share) return null;
  const updated = await this.options.service.uninvite(share.id, email);
  if (updated.access === "invited" && !updated.invites?.length) {
    await this.unshareConversation(conversationId);
    return null;
  }
  this.store(updated);
  this.options.changed("conversation", conversationId);
  return this.present(updated);
}

/** Chats other people shared with this account. */
export function sharedWithMe(this: HostedShares) {
  return this.options.service.sharedWithMe();
}

export async function inviteToArtifact(
  this: HostedShares,
  id: string,
  email: string,
  options?: ShareInviteOptions,
) {
  await this.allowed("artifact");
  const result = await this.options.service.invite(id, email, options);
  if (result.share.kind !== "artifact") throw new Error("The request failed.");
  this.store(result.share);
  this.options.changed("artifact", this.present(result.share).sourceKey);
  return { ...result, share: this.present(result.share) };
}

export async function removeArtifactInvite(
  this: HostedShares,
  id: string,
  email: string,
) {
  const share = await this.options.service.uninvite(id, email);
  if (share.kind !== "artifact") throw new Error("The request failed.");
  this.store(share);
  this.options.changed("artifact", this.present(share).sourceKey);
  return this.present(share);
}

export function editSharedArtifact(
  this: HostedShares,
  token: string,
  patch: { content?: string; comment?: string },
) {
  if (!this.options.service.editSharedArtifact)
    throw new Error(unavailableMessage);
  return this.options.service.editSharedArtifact(token, patch);
}

/** One shared chat's messages, by the token in its link. */
export function readSharedChat(this: HostedShares, token: string) {
  return this.options.service.readShared(token);
}

export function requestArtifactEditAccess(this: HostedShares, token: string) {
  return (
    this.options.service.requestArtifactEditAccess?.(token) ??
    Promise.resolve("unavailable" as const)
  );
}

export function respondArtifactEditAccess(
  this: HostedShares,
  token: string,
  email: string,
  allow: boolean,
) {
  if (!this.options.service.respondArtifactEditAccess)
    throw new Error(unavailableMessage);
  return this.options.service.respondArtifactEditAccess(token, email, allow);
}

/** Reports a chat shared with this account to the administrator. */
export function reportSharedChat(
  this: HostedShares,
  token: string,
  report: SharedChatReport,
) {
  return this.options.service.reportShared(token, report);
}

/** Stops the conversation's link; nothing to stop is not an error. */
export async function unshareConversation(
  this: HostedShares,
  conversationId: string,
) {
  const key = sourceKeyOf("conversation", conversationId);
  await this.list("conversation");
  const shares = (this.listCache?.shares ?? []).filter(
    (share) => share.kind === "conversation" && share.sourceKey === key,
  );
  for (const share of shares) {
    await this.options.service.revoke(share.id);
    this.forget(share.id);
  }
  this.sources.delete(key);
  this.save();
  this.options.changed("conversation", conversationId);
}
