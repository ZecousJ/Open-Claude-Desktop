import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Conversation, Item, Project, Turn } from "../../shared/types";
import type { ImportedCodeTranscriptRow } from "../../shared/imported-code-transcript";
import type { CodePermissionMode } from "../../shared/code-session-permissions";

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

const record = z.record(z.string(), z.unknown());
const sourceRow = z
  .object({
    sessionId: z.string(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    customTitle: z.string().optional(),
    permissionMode: z.string().optional(),
  })
  .passthrough();
const transcriptRow = z.object({
  type: z.enum(["user", "assistant", "system"]),
  uuid: z.string().min(1),
  parentUuid: z.string().nullable().default(null),
  sessionId: z.string(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().default(false),
  isMeta: z.boolean().optional(),
  parent_tool_use_id: z.string().optional(),
  agentId: z.string().optional(),
  message: z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(record)]),
    stop_reason: z.string().nullable().optional(),
    usage: record.nullable().optional(),
  }),
  toolUseResult: z.unknown().optional(),
  mcpMeta: record.optional(),
  claudexToolProgress: z.string().optional(),
  claudexToolResultWarnings: z.array(z.string()).optional(),
  claudexUnsupported: z.array(z.string()).optional(),
  claudexReasoning: z.array(z.string()).optional(),
  claudexSentPrompts: z.array(z.string()).optional(),
  origin: record.optional(),
  isApiErrorMessage: z.boolean().optional(),
  subtype: z.string().optional(),
  content: z.string().optional(),
  compact_metadata: record.optional(),
  compactMetadata: record.optional(),
  status: z.string().nullable().optional(),
  compact_result: z.string().optional(),
});

const permissionModes: Readonly<Partial<Record<string, CodePermissionMode>>> = {
  default: "manual",
  plan: "plan",
  dontAsk: "manual",
  acceptEdits: "acceptEdits",
  bypassPermissions: "acceptEdits",
  auto: "auto",
};

function importedRows(rows: z.infer<typeof sourceRow>[]) {
  const messages = new Map<string, ImportedCodeTranscriptRow>();
  for (const row of rows) {
    if (row.isVisibleInTranscriptOnly || row.isCompactSummary) continue;
    const system = row.type === "system" && !row.message;
    const message = object(row.message);
    const parsed = transcriptRow.safeParse({
      ...row,
      type: row.type ?? message?.role,
      message: system ? { role: "assistant", content: [] } : row.message,
    });
    if (parsed.success && !messages.has(parsed.data.uuid)) {
      const timestamp = parsed.data.timestamp ?? new Date(0).toISOString();
      messages.set(parsed.data.uuid, { ...parsed.data, timestamp });
    }
  }
  return [...messages.values()];
}

export function readClaudeTranscript(text: string, sessionId: string) {
  const rows = text.split("\n").flatMap((line) => {
    try {
      const row = sourceRow.safeParse(JSON.parse(line));
      return row.success && row.data.sessionId === sessionId ? [row.data] : [];
    } catch {
      return [];
    }
  });
  const cwds = [...new Set(rows.flatMap((row) => (row.cwd ? [row.cwd] : [])))];
  const messages = importedRows(rows);
  const tools = new Map<string, Item>();
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  for (const row of messages) {
    const prompt =
      row.type === "user" &&
      !row.isMeta &&
      !row.isSidechain &&
      !row.parent_tool_use_id
        ? claudeMessageText(row.message.content)
        : "";
    const blocks = Array.isArray(row.message.content)
      ? row.message.content
      : [];
    const userInput =
      prompt ||
      (row.type === "user" &&
        !row.isMeta &&
        !row.isSidechain &&
        !row.parent_tool_use_id &&
        blocks.some((block) => block.type === "image"));
    if (!turn || userInput) {
      turn = {
        id: row.uuid,
        ...(userInput && { officialCodeEventId: row.uuid }),
        prompt,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: timestamp(row.timestamp),
        importedCodeTranscript: [],
      };
      turns.push(turn);
    }
    turn.importedCodeTranscript?.push(row);
    if (row.isMeta || row.isSidechain || row.parent_tool_use_id) continue;
    if (row.type === "assistant") {
      const reply = claudeMessageText(row.message.content);
      if (reply)
        turn.items.push({ id: row.uuid, type: "agentMessage", text: reply });
    }
    for (const block of blocks) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const tool: Item = {
          id: block.id,
          type: "dynamicToolCall",
          tool: block.name,
          input: block.input,
        };
        tools.set(tool.id, tool);
        turn.items.push(tool);
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const tool = tools.get(block.tool_use_id);
        if (tool) {
          tool.contentItems =
            typeof block.content === "string"
              ? [{ type: "text", text: block.content }]
              : block.content;
          tool.status = block.is_error === true ? "failed" : "completed";
        }
      }
    }
  }
  const latestFirst = [...rows].reverse();
  const mode = latestFirst.find((row) => row.permissionMode)?.permissionMode;
  return {
    rows,
    cwds,
    cwd: cwds[0],
    turns: messages.length ? turns : claudeTurns(rows),
    title:
      latestFirst.find((row) => row.customTitle)?.customTitle ??
      turns
        .find((entry) => entry.prompt)
        ?.prompt.split("\n")[0]
        .slice(0, 200),
    branch: latestFirst.find((row) => row.gitBranch)?.gitBranch,
    codePermissionMode:
      mode && Object.hasOwn(permissionModes, mode)
        ? permissionModes[mode]
        : undefined,
  };
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
