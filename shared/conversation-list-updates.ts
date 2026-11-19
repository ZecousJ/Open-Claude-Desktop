import { isDeviceExecutionCopy } from "./chat-devices-api";
import type { AppEvent, Conversation } from "./types";

const codeListMetadata = (unread: boolean, revision: number) => ({
  fields: ["code", unread, revision],
  updatedAt: 0,
  running: false,
});

function listMetadata(conversation: Conversation, cloudCode: boolean) {
  if (cloudCode && conversation.mode === "code" && !conversation.incognito)
    return codeListMetadata(conversation.unread === true, conversation.readStateRevision ?? 0);
  if (
    (conversation.mode !== "chat" && conversation.mode !== "cowork") ||
    conversation.incognito ||
    isDeviceExecutionCopy(conversation)
  ) return;
  const last = conversation.turns.at(-1);
  const createdAt = conversation.createdAt || conversation.turns[0]?.createdAt || 0;
  return {
    fields: [
      conversation.mode, conversation.title ?? "", conversation.model, createdAt,
      !!conversation.pinned, !!conversation.archived, conversation.projectId ?? null,
      !!conversation.webSearch, !!conversation.research, conversation.effort ?? null,
      !!conversation.memoryDisabled, !!conversation.unread, conversation.readStateRevision,
      last?.id, last?.status,
    ],
    updatedAt: conversation.updatedAt || last?.createdAt || createdAt,
    running: last?.status === "inProgress",
  };
}

/** Track list fields for one activation without retaining streamed transcripts. */
export function conversationListsChanged({ cloudCode = false } = {}) {
  const seen = new Map<string, NonNullable<ReturnType<typeof listMetadata>>>();
  return (event: AppEvent): boolean => {
    if (event.type === "resync") {
      seen.clear();
      return true;
    }
    let id: string;
    let current: ReturnType<typeof listMetadata>;
    if (event.type === "conversation") {
      id = event.conversation.id;
      current = listMetadata(event.conversation, cloudCode);
    } else if (cloudCode && event.type === "code-read-state") {
      id = event.conversationId;
      current = codeListMetadata(event.unread, event.readStateRevision);
    } else return false;
    const previous = seen.get(id);
    if (!current) return seen.delete(id);
    seen.set(id, current);
    if (!previous || current.fields.some((value, index) => value !== previous.fields[index]))
      return true;
    // The engine rewrites updatedAt for every streamed delta. A new turn
    // and its completion already notify through the fields above.
    return !current.running && current.updatedAt !== previous.updatedAt;
  };
}
