import { z } from "zod";
import { builtInAttachmentBytes } from "../../shared/client-policy";
import type { Attachment, Conversation, Item, Turn } from "../../shared/types";
import { convertCodeTranscript } from "../official-ui/native/code-transcript";
import { readClaudeTranscript } from "./claude-transcripts";

const space = z.object({ id: z.string().uuid(), name: z.string() });
const spacesFile = z.object({ spaces: z.array(z.unknown()) });

export function lasmMetadata(conversation: Conversation, spaceId?: string) {
  return {
    ...(conversation.mode === "chat" ? { sessionType: "chat" } : {}),
    hostLoopMode: true,
    ...(spaceId ? { spaceId } : {}),
  };
}

export function readLasmSpaces(bytes: Buffer) {
  try {
    const { spaces } = spacesFile.parse(JSON.parse(bytes.toString("utf8")));
    return new Map(
      spaces.flatMap((value) => {
        const parsed = space.safeParse(value);
        return parsed.success
          ? [[parsed.data.id, parsed.data.name] as const]
          : [];
      }),
    );
  } catch {
    return new Map<string, string>();
  }
}

export function lasmTranscript(
  conversation: Conversation,
  imageData: NonNullable<Parameters<typeof convertCodeTranscript>[1]>,
) {
  return convertCodeTranscript({ ...conversation, mode: "cowork" }, imageData);
}

const inputObject = z.record(z.string(), z.unknown());
const imageExtensions = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const inlineImage = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.string(),
  }),
});

export function readLasmTranscript(bytes: Buffer, cliSessionId: string) {
  const decoded = readClaudeTranscript(bytes.toString("utf8"), cliSessionId);
  for (const turn of decoded.turns) {
    if (!turn.importedCodeTranscript) continue;
    const tools = new Map<string, Item>();
    const items: Item[] = [];
    for (const row of turn.importedCodeTranscript) {
      if (
        row.isMeta ||
        row.isSidechain ||
        row.parent_tool_use_id ||
        row.type === "system"
      )
        continue;
      if (row.isApiErrorMessage) {
        turn.status = "failed";
        turn.error =
          typeof row.message.content === "string"
            ? row.message.content
            : row.message.content
                .flatMap((block) =>
                  typeof block.text === "string" ? [block.text] : [],
                )
                .join("\n");
        continue;
      }
      const blocks =
        typeof row.message.content === "string"
          ? [{ type: "text", text: row.message.content }]
          : row.message.content;
      for (const [index, block] of blocks.entries()) {
        const id = `${row.uuid}:${index}`;
        if (
          row.type === "assistant" &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          items.push({ id, type: "agentMessage", text: block.text });
        } else if (
          row.type === "assistant" &&
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          items.push({ id, type: "reasoning", summary: [block.thinking] });
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const input = inputObject.safeParse(block.input);
          const tool: Item = {
            id: block.id,
            type: "dynamicToolCall",
            tool: block.name,
            input: input.success ? input.data : {},
            status: "interrupted",
            result: "",
          };
          tools.set(tool.id, tool);
          items.push(tool);
        } else if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          const tool = tools.get(block.tool_use_id);
          if (tool) {
            tool.status = block.is_error === true ? "failed" : "completed";
            tool.result = row.toolUseResult ?? block.content ?? "";
            tool.contentItems =
              typeof block.content === "string"
                ? [{ type: "text", text: block.content }]
                : block.content;
          }
        }
      }
    }
    turn.items = items;
  }
  return decoded;
}

export function hydrateLasmImages(
  turns: Turn[],
  store: (name: string, bytes: Buffer) => Attachment,
) {
  let count = 0;
  for (const turn of turns) {
    const row = turn.importedCodeTranscript?.find(
      (row) => row.uuid === turn.id && row.type === "user" && !row.isMeta,
    );
    if (!row || typeof row.message.content === "string") continue;
    for (const block of row.message.content) {
      const parsed = inlineImage.safeParse(block);
      if (!parsed.success) continue;
      const { data, media_type } = parsed.data.source;
      if (data.length > Math.ceil(builtInAttachmentBytes.image / 3) * 4)
        continue;
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > builtInAttachmentBytes.image)
        continue;
      const name = `image-${turn.attachments.length + 1}${imageExtensions[media_type]}`;
      turn.attachments.push(store(name, bytes));
      count++;
    }
  }
  return count;
}
