import { codeEntryConversation, type DeepLink } from "../../shared/deep-links";
import { isDeviceExecutionCopy } from "../../shared/chat-devices-api";
import type { Conversation, Snapshot } from "../../shared/types";
import {
  isLocalCodeSession,
  isWslCodeSession,
} from "./api/code-session-ownership";

function nativeCode(conversation: Conversation) {
  return (
    isLocalCodeSession(conversation) ||
    isWslCodeSession(conversation) ||
    (conversation.mode === "code" &&
      conversation.environment?.kind === "ssh" &&
      !conversation.cloudHosted &&
      !conversation.cloudEnvironmentId)
  );
}

function nativeCowork(conversation: Conversation) {
  return (
    conversation.mode === "cowork" &&
    (!conversation.environment || conversation.environment.kind === "local") &&
    !conversation.cloudHosted &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding
  );
}

function conversationRoute(conversation: Conversation) {
  const id = encodeURIComponent(conversation.id);
  if (conversation.mode === "code")
    return nativeCode(conversation) ? `/epitaxy/local_${id}` : "/epitaxy";
  return nativeCowork(conversation) ? `/cowork/local_${id}` : `/chat/${id}`;
}

export function officialDeepLinkRoute(
  link: DeepLink,
  owner: string,
  snapshot?: Pick<Snapshot, "conversations"> & {
    approvals: readonly Pick<Snapshot["approvals"][number], "conversationId">[];
  },
) {
  const query = new URLSearchParams();
  switch (link.kind) {
    case "new": {
      if (link.prompt) query.set("q", link.prompt);
      if (link.mode === "chat") {
        query.set("mode", "chat");
        query.set("surface", "chat");
        return `/new?${query}`;
      }
      if (link.mode === "cowork")
        return query.size ? `/task/new?${query}` : "/task/new";
      if (link.folder) {
        query.set("folder", link.folder);
        query.set("src", "external");
      }
      return query.size ? `/epitaxy?${query}` : "/epitaxy";
    }
    case "ssh": {
      const { sshHost, sshPort, folder, prompt } = link.target;
      query.set("ssh_host", sshHost);
      if (sshPort !== undefined) query.set("ssh_port", String(sshPort));
      if (folder) query.set("ssh_folder", folder);
      if (prompt) query.set("q", prompt);
      query.set("src", "external");
      return `/epitaxy?${query}`;
    }
    case "ssh-error":
      return `/epitaxy?ssh_refused=${link.error}`;
    case "project":
      return `/project/${encodeURIComponent(link.id)}`;
  }

  const conversations = (snapshot?.conversations ?? []).filter(
    (conversation) => {
      const authors = conversation.sessionAuthors;
      return (
        !conversation.incognito &&
        !isDeviceExecutionCopy(conversation) &&
        (!authors ||
          (authors.ownerAccountUuid === owner &&
            authors.viewerAccountUuid === owner))
      );
    },
  );
  if (link.kind === "conversation" && link.id !== "last") {
    const target = conversations.find(
      (conversation) => conversation.id === link.id,
    );
    return target ? conversationRoute(target) : "/recents";
  }
  const waiting = new Set(
    snapshot?.approvals.map((approval) => approval.conversationId),
  );
  const native = conversations.filter(
    (conversation) => nativeCode(conversation) || nativeCowork(conversation),
  );
  const target = codeEntryConversation(link, native, waiting);
  return target ? conversationRoute(target) : "/epitaxy";
}
