import type { Conversation } from "./types";

/** Hosted export envelope. */
export function sessionExport(conversation: Conversation, now = Date.now()) {
  return {
    exportedAt: new Date(now).toISOString(),
    session: {
      id: conversation.id,
      title: conversation.title || "Untitled",
      session_status: conversation.turns.at(-1)?.status ?? "idle",
      updated_at: new Date(conversation.updatedAt).toISOString(),
      session_context: { model: conversation.model },
    },
    messages: conversation.turns.flatMap((turn) => [
      {
        type: "user",
        uuid: turn.id,
        timestamp: new Date(turn.createdAt).toISOString(),
        message: { role: "user", content: turn.prompt },
        attachments: turn.attachments,
      },
      ...turn.items.map((item) => ({
        type: item.type === "agentMessage" ? "assistant" : item.type,
        turnId: turn.id,
        item,
      })),
    ]),
  };
}
