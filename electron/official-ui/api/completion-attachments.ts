/** Exact REST producer attachments. Never interprets renderer metadata as a path or permission. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { prepareDerivedTextAttachment } from "./derived-text-attachment";
export const completionFilesSchema = z
  .array(z.string().min(1).max(200))
  .max(12)
  .default([]);
export const completionInlineSchema = z
  .array(
    z
      .object({
        file_name: z.string().min(1).max(500),
        file_type: z.string().max(500),
        file_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        extracted_content: z.string().max(1024 * 1024),
        origin: z
          .enum(["url_parameter", "user_upload", "first_party"])
          .optional(),
        kind: z
          .enum([
            "file",
            "pasted_text",
            "excerpt",
            "progress_item",
            "embed_selection",
          ])
          .optional(),
      })
      .strict(),
  )
  .max(12)
  .default([]);
/** Native inline text preserves the original per-file 2 MiB text ceiling.
 * UTF-8 bytes are validated by prepareDerivedTextAttachment before storage. */
export const nativeCompletionInlineSchema = z.array(
  completionInlineSchema.removeDefault().element.extend({
    extracted_content: z.string().max(2 * 1024 * 1024),
    quote_message_uuid: z.string().min(1).max(256).optional(),
  }),
).max(12).default([]);
export interface CompletionAttachmentInput {
  model: string;
  providerId: string;
  conversationId?: string;
  files: string[];
  attachments: z.infer<typeof completionInlineSchema>;
}
export interface OwnedCompletionFile {
  id: string;
  name: string;
  size: number;
  kind: "image" | "text" | "document";
}
export type PreparedCompletionAttachment =
  | {
      source: "owned-file";
      id: string;
      name: string;
      size: number;
      kind: OwnedCompletionFile["kind"];
    }
  | {
      source: "extracted-text";
      quoteSource?: import("../../../shared/inline-attachment-display").InlineQuoteSource;
      display?: {file_name:string;file_type:string;kind?:string;quote_message_uuid?:string};
      name: string;
      mediaType: "text/plain";
      size: number;
      sha256: string;
      text: string;
    };
export interface CompletionAttachmentCapability {
  version: 1;
  maxCount: number;
  maxTotalBytes: number;
  ownedFileKinds: OwnedCompletionFile["kind"][];
  extractedText: boolean;
}
export class CompletionAttachmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function validateAttachmentCapability(
  value: unknown,
): CompletionAttachmentCapability {
  const parsed = z
    .object({
      version: z.literal(1),
      maxCount: z.number().int().min(1).max(12),
      maxTotalBytes: z
        .number()
        .int()
        .min(1)
        .max(32 * 1024 * 1024),
      ownedFileKinds: z.array(z.enum(["image", "text", "document"])).max(4),
      extractedText: z.boolean(),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success)
    throw new CompletionAttachmentError(
      501,
      "attachments_unavailable",
      "Attachment execution capabilities could not be verified.",
    );
  return parsed.data;
}
export async function prepareCompletionAttachments(
  input: CompletionAttachmentInput,
  host: {
    capability(): Promise<unknown>;
    lookupOwned(id: string): Promise<OwnedCompletionFile | undefined>;
    isCurrent(): boolean;
  },
): Promise<PreparedCompletionAttachment[]> {
  const check = () => {
    if (!host.isCurrent())
      throw new CompletionAttachmentError(
        409,
        "attachment_activation_changed",
        "The account changed. Reattach the files before sending.",
      );
  };
  check();
  const capability = validateAttachmentCapability(await host.capability());
  check();
  const files = completionFilesSchema.parse(input.files),
    inline = completionInlineSchema.parse(input.attachments);
  if (files.length + inline.length > capability.maxCount)
    throw new CompletionAttachmentError(
      413,
      "attachment_limit",
      "Too many attachments for this executor.",
    );
  if (new Set(files).size !== files.length)
    throw new CompletionAttachmentError(
      400,
      "duplicate_attachment",
      "The same file was attached more than once.",
    );
  const result: PreparedCompletionAttachment[] = [];
  let total = 0;
  const add = (entry: PreparedCompletionAttachment) => {
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > capability.maxTotalBytes)
      throw new CompletionAttachmentError(
        413,
        "attachment_limit",
        "Attachments exceed the executor byte limit.",
      );
    result.push(entry);
  };
  for (const id of files) {
    check();
    let file: OwnedCompletionFile | undefined;
    try {
      file = await host.lookupOwned(id);
    } catch {
      check();
      throw new CompletionAttachmentError(
        503,
        "attachment_source_unavailable",
        "The attachment source could not be read. No attachment send was started.",
      );
    }
    check();
    if (
      !file ||
      file.id !== id ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 500 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new CompletionAttachmentError(
        404,
        "files_not_found",
        "An attachment is unavailable in this account. Add it again.",
      );
    if (!capability.ownedFileKinds.includes(file.kind))
      throw new CompletionAttachmentError(
        501,
        "attachment_kind_unavailable",
        "This executor does not support that attachment type.",
      );
    add({
      source: "owned-file",
      id: file.id,
      name: file.name,
      size: file.size,
      kind: file.kind,
    });
  }
  for (const item of inline) {
    if (!capability.extractedText)
      throw new CompletionAttachmentError(
        501,
        "attachment_kind_unavailable",
        "This executor does not support extracted text attachments.",
      );
    let derived: ReturnType<typeof prepareDerivedTextAttachment>;
    try {
      derived = prepareDerivedTextAttachment({
        fileName: item.file_name,
        fileType: item.file_type,
        extractedContent: item.extracted_content,
      });
    } catch {
      throw new CompletionAttachmentError(
        400,
        "invalid_extracted_attachment",
        "The extracted text attachment is invalid or exceeds its UTF-8 limit. Remove it and attach it again.",
      );
    }
    add({
      source: "extracted-text",
      name: derived.name,
      mediaType: "text/plain",
      size: derived.data.byteLength,
      sha256: createHash("sha256").update(derived.data).digest("hex"),
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        derived.data,
      ),
    });
  }
  check();
  return result;
}
