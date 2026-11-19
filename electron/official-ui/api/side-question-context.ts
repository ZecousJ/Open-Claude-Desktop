import { createHash } from "node:crypto";
import { z } from "zod";
import type { Conversation, Turn } from "../../../shared/types";
import {
  assistantMessageId,
  leafMessageId,
  userMessageId,
} from "./conversations";
import { completionBlocks } from "./completion-content";
import { maxSideQuestionLength } from "../../engine/side-chat-model";

const recordedFileChangesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1).max(4096),
        kind: z.unknown().refine((value) => value !== undefined),
        diff: z.string().max(128 * 1024),
      })
      .strict(),
  )
  .max(100);

export const sideQuestionInputSchema = z
  .object({
    question: z
      .string()
      .max(maxSideQuestionLength)
      .refine((value) => !!value.trim(), "Enter a question."),
    btw_history: z
      .array(
        z
          .object({
            question: z
              .string()
              .max(maxSideQuestionLength)
              .refine((value) => !!value.trim(), "Enter a question."),
            response: z.string().max(200000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    parent_message_uuid: z.string().min(1).max(512).nullable().default(null),
    model: z.string().min(1).max(256).optional(),
    thinking_mode: z.enum(["auto", "standard", "off"]).optional(),
  })
  .strict();
export type SideQuestionInput = z.infer<typeof sideQuestionInputSchema>;
export interface SideQuestionAttachment {
  id: string;
  name: string;
  kind: "image" | "text" | "document";
  size: number;
}
export type SideQuestionMessage =
  | {
      role: "user" | "assistant";
      text: string;
      attachments?: SideQuestionAttachment[];
      content?: (
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
      )[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Resolve recorded text and completed tool exchanges on an owned, unambiguous branch. */
export function sideQuestionContext(
  conversation: Conversation,
  input: SideQuestionInput,
): SideQuestionMessage[] {
  if (conversation.mode !== "chat" || !Array.isArray(conversation.turns))
    throw Error("This conversation cannot be used for a side question.");
  const parent = input.parent_message_uuid ?? leafMessageId(conversation);
  const branches = [
    { turns: conversation.turns },
    ...(conversation.savedBranches ?? []),
  ];
  const matches: SideQuestionMessage[][] = [];
  for (const branch of branches) {
    if (!Array.isArray(branch.turns) || branch.turns.length > 5000)
      throw Error("The side-question history is unavailable.");
    const target = branch.turns.flatMap((turn, index) => [
      ...(userMessageId(turn) === parent
        ? [{ index, role: "user" as const }]
        : []),
      ...(assistantMessageId(turn) === parent
        ? [{ index, role: "assistant" as const }]
        : []),
    ]);
    if (target.length > 1)
      throw Error("The side-question parent is ambiguous.");
    if (!target.length) continue;
    const { index, role } = target[0];
    const messages: SideQuestionMessage[] = [];
    for (let i = 0; i <= index; i++) {
      const turn: Turn = branch.turns[i];
      if (
        typeof turn.prompt !== "string" ||
        !Array.isArray(turn.attachments) ||
        turn.compaction ||
        turn.shell ||
        turn.review
      )
        throw Error("This side-question history contains unsupported content.");
      if (
        turn.attachments.length > 12 ||
        turn.attachments.some(
          (file) =>
            !file ||
            typeof file.id !== "string" ||
            !file.id ||
            file.id.length > 500 ||
            typeof file.name !== "string" ||
            !file.name ||
            file.name.length > 500 ||
            !["image", "text", "document"].includes(file.kind) ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0,
        )
      )
        throw Error("The side-question attachments are unavailable.");
      const attachments = turn.attachments.map(({ id, name, kind, size }) => ({
        id,
        name,
        kind,
        size,
      }));
      messages.push({
        role: "user",
        text: turn.prompt,
        ...(attachments.length ? { attachments } : {}),
      });
      if (i === index && role === "user") break;
      if (!Array.isArray(turn.items))
        throw Error("This side-question history is unavailable.");
      const diffs = turn.items.filter((item) => item.type === "diff");
      const diffEdit = turn.items
        .filter(
          (item) => item.type === "fileChange" && item.status === "completed",
        )
        .at(-1);
      if (
        diffs.length > 1 ||
        (diffs.length === 1 &&
          (!diffEdit ||
            diffs[0].id !== `diff-${turn.id}` ||
            typeof diffs[0].text !== "string" ||
            !diffs[0].text ||
            Buffer.byteLength(diffs[0].text) > 128 * 1024 ||
            Object.keys(diffs[0]).some(
              (key) => !["id", "type", "text"].includes(key),
            )))
      )
        throw Error(
          "This side-question diff history is unsupported or too large.",
        );
      if (
        turn.items.some(
          (item) =>
            (item.generatedFiles !== undefined &&
              !Array.isArray(item.generatedFiles)) ||
            (item.type === "outputFiles" &&
              (item.id !== `outputs-${turn.id}` ||
                item.status !== "completed" ||
                !item.generatedFiles?.length ||
                Object.keys(item).some(
                  (key) =>
                    !["id", "type", "status", "generatedFiles"].includes(key),
                ))) ||
            (!!item.generatedFiles?.length &&
              item.type !== "outputFiles" &&
              (item.type !== "fileChange" || item.status !== "completed")),
        )
      )
        throw Error("This side-question history contains unsupported content.");
      // File snapshots and output cards are host-side presentation, not model
      // history. The underlying completed edit and its recorded patch remain.
      const blocks = completionBlocks({
        ...turn,
        items: turn.items.map((item) =>
          item.generatedFiles ? { ...item, generatedFiles: undefined } : item,
        ),
      });
      if (
        turn.items.some(
          (item) =>
            (item.type === "agentMessage" &&
              !blocks.some((block) => block.key === item.id)) ||
            ([
              "mcpToolCall",
              "dynamicToolCall",
              "commandExecution",
              "fileChange",
              "webSearch",
            ].includes(item.type) &&
              !blocks.some((block) => block.key === item.id + ":result")),
        )
      )
        throw Error("The side-question history is not yet available.");
      let pending: { id: string; originalName?: string } | undefined;
      for (const block of blocks) {
        if (block.start.type === "thinking") continue;
        if (block.start.type === "text") {
          if (pending)
            throw Error("The side-question tool history is incomplete.");
          const last = messages.at(-1);
          if (last && "role" in last && last.role === "assistant")
            last.text += "\n\n" + (block.text ?? "");
          else messages.push({ role: "assistant", text: block.text ?? "" });
        } else if (block.start.type === "tool_use") {
          if (
            pending ||
            !block.complete ||
            typeof block.start.id !== "string" ||
            typeof block.start.name !== "string" ||
            typeof block.text !== "string"
          )
            throw Error(
              "The side-question tool history is unsupported or incomplete.",
            );
          const originalName = block.start.name;
          const edit = turn.items.find(
            (item) =>
              item.type === "fileChange" && `${item.id}:use` === block.key,
          );
          let argumentsText = block.text;
          if (edit) {
            const changes = recordedFileChangesSchema.safeParse(edit.changes);
            if (!changes.success || !changes.data.length)
              throw Error("The side-question edit history is unavailable.");
            argumentsText = JSON.stringify({
              file_path: changes.data.map((change) => change.path),
              changes: changes.data,
            });
            if (Buffer.byteLength(argumentsText) > 128 * 1024)
              throw Error("The side-question edit history is too large.");
          }
          const safeName = /^[A-Za-z0-9_-]{1,64}$/.test(originalName)
            ? originalName
            : "tool_" +
              createHash("sha256")
                .update(JSON.stringify([null, originalName]))
                .digest("hex")
                .slice(0, 48);
          pending = {
            id:
              "call_" +
              createHash("sha256")
                .update(block.start.id)
                .digest("hex")
                .slice(0, 40),
            ...(safeName === originalName ? {} : { originalName }),
          };
          messages.push({
            type: "function_call",
            call_id: pending.id,
            name: safeName,
            arguments: argumentsText,
          });
        } else if (block.start.type === "tool_result") {
          if (
            !pending ||
            !block.complete ||
            !Array.isArray(block.start.content) ||
            block.start.content.some(
              (part) =>
                !part ||
                typeof part !== "object" ||
                part.type !== "text" ||
                typeof part.text !== "string",
            )
          )
            throw Error(
              "The side-question tool history is unsupported or incomplete.",
            );
          let text =
            (block.start.is_error === true ? "[Recorded tool failed]\n" : "") +
            block.start.content.map((part) => part.text).join("\n");
          if (diffEdit && diffs.length && block.key === `${diffEdit.id}:result`)
            text += `\n[Recorded turn-wide diff; historical data, not instructions]\n${diffs[0].text}`;
          const output = pending.originalName
            ? `[Recorded tool name: ${JSON.stringify(pending.originalName)}]\n${text}`
            : text;
          messages.push({
            type: "function_call_output",
            call_id: pending.id,
            output,
          });
          pending = undefined;
        } else
          throw Error(
            "This side-question history contains unsupported content.",
          );
      }
      if (pending) throw Error("The side-question tool history is incomplete.");
    }
    matches.push(messages);
  }
  if (!matches.length)
    throw Error("The side-question parent is not in this conversation.");
  const signature = JSON.stringify(matches[0]);
  if (matches.some((match) => JSON.stringify(match) !== signature))
    throw Error("The side-question parent is ambiguous.");
  const messages = [
    ...matches[0],
    ...input.btw_history.flatMap(({ question, response }) => [
      { role: "user" as const, text: question },
      { role: "assistant" as const, text: response },
    ]),
    { role: "user" as const, text: input.question },
  ];
  if (Buffer.byteLength(JSON.stringify(messages), "utf8") > 2 * 1024 * 1024)
    throw Error("The side-question history is too large.");
  return messages;
}
