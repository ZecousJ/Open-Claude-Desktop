import { z } from "zod";

const identity = z.string().min(1).max(200);
export const inlineQuoteSourceSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), promptKey: identity }).strict(),
  z.object({ role: z.literal("assistant"), turnId: identity }).strict(),
]);
export type InlineQuoteSource = z.infer<typeof inlineQuoteSourceSchema>;
const label = z
  .string()
  .max(500)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const displayFields = z
  .object({
    version: z.literal(1),
    attachmentId: identity,
    fileName: label.min(1),
    fileType: label,
    kind: z
      .enum([
        "file",
        "pasted_text",
        "excerpt",
        "progress_item",
        "embed_selection",
      ])
      .optional(),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const inlineAttachmentDisplaySchema = z.union([
  displayFields
    .extend({
      kind: z.literal("excerpt"),
      quoteSource: inlineQuoteSourceSchema,
    })
    .strict(),
  displayFields.extend({ quoteSource: z.undefined().optional() }).strict(),
]);
export const inlineAttachmentDisplaysSchema = z
  .array(inlineAttachmentDisplaySchema)
  .max(12);
export type InlineAttachmentDisplay = z.infer<
  typeof inlineAttachmentDisplaySchema
>;

export function parseInlineAttachmentDisplays(
  value: unknown,
  attachmentIds: readonly string[],
): InlineAttachmentDisplay[] {
  const displays = inlineAttachmentDisplaysSchema.parse(value);
  const seen = new Set<string>();
  for (const display of displays) {
    if (
      seen.has(display.attachmentId) ||
      attachmentIds.filter((id) => id === display.attachmentId).length !== 1
    )
      throw Error("The inline attachment binding is invalid.");
    seen.add(display.attachmentId);
  }
  return displays;
}

export const inlineDisplayKey = (turnId: string, attachmentId: string) =>
  JSON.stringify([turnId, attachmentId]);
export const promptKey = (turn: {
  promptVersionId?: string;
  responseGroupId?: string;
  id: string;
}) => turn.promptVersionId ?? turn.responseGroupId ?? turn.id;
