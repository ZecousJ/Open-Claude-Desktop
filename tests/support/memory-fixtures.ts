/** Conversations for the memory tests. */
import type { Conversation, Turn } from "../../shared/types";

let counter = 0;
export function turn(prompt: string, reply: string): Turn {
  counter++;
  return {
    id: `t${counter}`,
    prompt,
    attachments: [],
    items: [{ id: `i${counter}`, type: "agentMessage", text: reply }],
    status: "completed",
    createdAt: counter,
  };
}

export function chat(
  id: string,
  title: string,
  exchanges: [string, string][],
  extra: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title,
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1_000,
    turns: exchanges.map(([prompt, reply]) => turn(prompt, reply)),
    ...extra,
  } as Conversation;
}
