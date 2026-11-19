import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseInlineAttachmentDisplays,
  promptKey,
  type InlineAttachmentDisplay,
  type InlineQuoteSource,
} from "../../shared/inline-attachment-display";
import type { Attachment, Conversation, Turn } from "../../shared/types";
import { completionQuoteVisibleParagraphs } from "./completion-quote-visible-text";
import { prepareDerivedTextAttachment } from "../engine/derived-text-attachment";

export function inlineQuoteSource(
  conversation: Conversation | undefined,
  source: InlineQuoteSource,
): Turn {
  if (!conversation) throw Error("The quoted source is unavailable.");
  const candidates = [
    ...(conversation.savedBranches ?? []).flatMap((branch) => branch.turns),
    ...conversation.turns,
  ].filter((turn) =>
    source.role === "user"
      ? promptKey(turn) === source.promptKey
      : turn.id === source.turnId,
  );
  if (!candidates.length) throw Error("The quoted source is unavailable.");
  const text = inlineQuoteText(candidates[0], source.role);
  if (candidates.some((turn) => inlineQuoteText(turn, source.role) !== text))
    throw Error("The quoted source is ambiguous.");
  return candidates[candidates.length - 1];
}
function inlineQuoteText(turn: Turn, role: InlineQuoteSource["role"]) {
  const text =
    role === "user"
      ? turn.prompt
      : turn.items
          .filter(
            (item) => item.type === "text" || item.type === "agentMessage",
          )
          .map((item) => item.text ?? "")
          .join("\n\n");
  if (text.length > 1024 * 1024) throw Error("The quoted source is too large.");
  return text;
}
export function verifyInlineDisplayBytes(
  display: InlineAttachmentDisplay,
  attachment: Attachment,
  data: Uint8Array,
  conversation?: Conversation,
) {
  if (attachment.kind !== "text")
    throw Error("An inline attachment must contain text.");
  if (
    data.byteLength !== display.bytes ||
    attachment.size !== display.bytes ||
    createHash("sha256").update(data).digest("hex") !== display.sha256
  )
    throw Error("The inline attachment bytes changed.");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(data);
  const derived = prepareDerivedTextAttachment({
    fileName: display.fileName,
    fileType: display.fileType,
    extractedContent: text,
  });
  if (derived.name !== attachment.name)
    throw Error("The inline attachment name changed.");
  if (display.quoteSource) {
    const source = inlineQuoteSource(conversation, display.quoteSource);
    const normalized = (value: string) =>
      value.replace(/\r\n?/g, "\n").replace(/\0/g, "");
    const excerpt = normalized(text),
      sourceText = normalized(
        inlineQuoteText(source, display.quoteSource.role),
      );
    if (
      !excerpt.trim() ||
      Array.from(text).length > 10000 ||
      (!sourceText.includes(excerpt) &&
        !(
          display.quoteSource.role === "assistant" &&
          completionQuoteVisibleParagraphs(sourceText)?.some((paragraph) =>
            paragraph.includes(excerpt),
          )
        ))
    )
      throw Error("The quoted passage does not match its source message.");
  }
  return text;
}

/** Engine-owned files only. The metadata never grants a path or a conversation. */
export function verifyOwnedInlineDisplays(input: {
  displays: unknown;
  attachments: readonly Attachment[];
  root: string;
  conversation?: Conversation;
}) {
  const displays = parseInlineAttachmentDisplays(
    input.displays,
    input.attachments.map((file) => file.id),
  );
  const text = new Map<string, string>();
  if (!displays.length) return { displays, text };
  const root = fs.realpathSync(path.join(input.root, "attachments"));
  for (const display of displays) {
    const file = input.attachments.find(
      (file) => file.id === display.attachmentId,
    )!;
    const real = fs.realpathSync(file.path);
    if (
      !real.startsWith(root + path.sep) ||
      fs.statSync(real).size > 2 * 1024 * 1024
    )
      throw Error("The inline attachment is not owned by this account.");
    text.set(
      file.id,
      verifyInlineDisplayBytes(
        display,
        file,
        fs.readFileSync(real),
        input.conversation,
      ),
    );
  }
  return { displays, text };
}
