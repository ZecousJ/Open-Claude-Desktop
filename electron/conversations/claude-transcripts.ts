import { randomUUID } from "node:crypto";
import type { Conversation, Project, Turn } from "../../shared/types";

const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
const timestamp = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function claudeMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const block = object(part);
      return block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}

/** Import messages as inert transcript text, never as executable tool calls. */
export function claudeTurns(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];
  const seen = new Set<string>();
  for (const raw of messages) {
    const entry = object(raw);
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const message = object(entry.message) ?? entry;
    const role = message.role ?? entry.sender ?? entry.type;
    if (!["user", "human", "assistant"].includes(role)) continue;
    const text =
      claudeMessageText(message.content) ||
      (typeof message.text === "string" ? message.text : "");
    if (!text) continue;
    const key =
      entry.uuid ??
      (typeof message.id === "string" ? `${message.id}:${text}` : undefined);
    if (typeof key === "string") {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const createdAt = timestamp(entry.timestamp ?? entry.created_at);
    if (role !== "assistant") {
      turns.push({
        id: randomUUID(),
        prompt: text,
        attachments: [],
        items: [],
        status: "completed",
        createdAt,
      });
    } else {
      if (!turns.length)
        turns.push({
          id: randomUUID(),
          prompt: "",
          attachments: [],
          items: [],
          status: "completed",
          createdAt,
        });
      turns
        .at(-1)!
        .items.push({ id: randomUUID(), type: "agentMessage", text });
    }
  }
  return turns;
}

export function claudeConversation(raw: unknown): Conversation | undefined {
  const entry = object(raw);
  if (
    !entry ||
    typeof entry.uuid !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(entry.uuid) ||
    !Array.isArray(entry.chat_messages)
  )
    return undefined;
  return {
    id: `claude-ai:${entry.uuid}`,
    title: typeof entry.name === "string" ? entry.name : "",
    mode: "chat",
    providerId: "",
    model: "",
    pinned: false,
    archived: false,
    createdAt: timestamp(entry.created_at),
    updatedAt: timestamp(entry.updated_at),
    turns: claudeTurns(entry.chat_messages),
    importedHistory: true,
    ...(typeof entry.project_uuid === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/.test(entry.project_uuid)
      ? { projectId: `claude-ai:${entry.project_uuid}` }
      : {}),
  };
}

export function claudeProject(raw: unknown): Project | undefined {
  const entry = object(raw);
  if (
    !entry ||
    typeof entry.uuid !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(entry.uuid) ||
    typeof entry.name !== "string" ||
    !entry.name.trim()
  )
    return undefined;
  return {
    id: `claude-ai:${entry.uuid}`,
    name: entry.name.slice(0, 100),
    description: typeof entry.description === "string" ? entry.description : "",
    instructions:
      typeof entry.prompt_template === "string" ? entry.prompt_template : "",
    createdAt: timestamp(entry.created_at),
  };
}
