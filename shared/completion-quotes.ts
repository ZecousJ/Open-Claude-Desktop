/** Quote presentation metadata, never account ownership or model authority.
 * Callers must revalidate source IDs against their current conversation lease
 * before dispatch. This pure module neither resolves sources nor grants access.
 */
import { z } from "zod";

const maxPromptBytes = 1024 * 1024;
function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const unicode = z.string().refine(validUnicode, "Invalid quote Unicode");
const bounded = unicode.refine(value => Array.from(value).length <= 10_000, "Quote text is too large");
const canonical = (value: string) => value.replace(/\r\n?/g, "\n").replaceAll("\0", "");
const blank = (value: string) => Array.from(value).every(char => {
  const code = char.codePointAt(0)!;
  return (code >= 9 && code <= 13) || (code >= 28 && code <= 32) ||
    [133, 160, 5760, 8232, 8233, 8239, 8287, 12288].includes(code) || (code >= 8192 && code <= 8202);
});
export const isCompletionQuoteSourceId = (value: string) => value.length <= 256 && (
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
  /^msg_[A-Za-z0-9_]{1,252}$/.test(value) || /^[A-Za-z0-9_.:-]{1,245}:(?:user|assistant)$/.test(value));
const sourceId = unicode.max(256).refine(isCompletionQuoteSourceId, "Unsupported quote source identity");
export const completionQuoteSchema = z.object({
  passage: z.object({
    case: z.literal("excerpt"),
    value: z.object({
      text: bounded.refine(value => value === canonical(value) && !!value.trim(), "Noncanonical quote passage"),
      targetMessageId: sourceId.optional(),
      prefix: bounded.optional(),
      suffix: bounded.optional(),
    }).strict(),
  }).strict(),
  /** Original display role only, not a system/developer instruction. */
  author: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  comment: bounded.refine(value => value === canonical(value) && !blank(value), "Noncanonical quote comment").optional(),
  startIndex: z.number().int().min(0).max(maxPromptBytes),
  endIndex: z.number().int().min(1).max(maxPromptBytes),
}).strict();
export const completionQuotesSchema = z.array(completionQuoteSchema).max(10);
export type CompletionQuote = z.infer<typeof completionQuoteSchema>;
const prompt = unicode.refine(value => new TextEncoder().encode(value).byteLength <= maxPromptBytes, "Quoted prompt exceeds 1 MiB");

function block(quote: CompletionQuote): string {
  return quote.passage.value.text.split("\n").map(line => line === "" ? ">" : "> " + line).join("\n") +
    (quote.comment === undefined ? "\n\n(quoted for context; no request)" : "\n\n" + quote.comment) + "\n\n";
}
/** Strict history boundary. Ranges must describe the exact normalized prefix of
 * the stored prompt, with neither gaps nor overlaps. Returns detached metadata.
 * The remaining prompt suffix is the user's typed text, never another quote.
 */
export function parsePersistedCompletionQuotes(text: unknown, value: unknown): CompletionQuote[] {
  const body = prompt.parse(text);
  const quotes = completionQuotesSchema.parse(value);
  let prefix = "", offset = 0;
  for (const quote of quotes) {
    const rendered = block(quote);
    const end = offset + Array.from(rendered).length;
    if (quote.startIndex !== offset || quote.endIndex !== end) throw Error("Quote range does not match its rendered block");
    prefix += rendered;
    offset = end;
  }
  if (!body.startsWith(prefix)) throw Error("Quote content does not match the stored prompt");
  return quotes;
}
const prepared = z.object({ text: prompt, typedText: prompt, quotes: completionQuotesSchema }).strict();
/** Validate an explicitly selected normalizer payload. Do not pass its diagnostic
 * ownership fields into storage. No successful parse is an authorization token.
 */
export function validateCompletionQuotes(value: unknown): CompletionQuote[] {
  const input = prepared.parse(value);
  const quotes = parsePersistedCompletionQuotes(input.text, input.quotes);
  if (quotes.map(block).join("") + input.typedText !== input.text)
    throw Error("Prepared quote text differs from its typed suffix");
  return quotes;
}
