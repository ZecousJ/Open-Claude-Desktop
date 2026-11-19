import type { InlineQuoteSource } from "../../../shared/inline-attachment-display";
/** Resolves only text in the caller's already-owned conversation. No reads or dispatch. */
import type { Conversation, Turn } from "../../../shared/types";
import { promptKey, type MessageRef } from "./conversations";
import { completionQuoteVisibleParagraphs } from "./completion-quote-visible-text";

export interface QuoteSourceContext {
  conversation?: Conversation;
  /** Must represent the account/activation lease under which conversation was loaded. */
  current(): boolean;
  userMessageId(turn: Turn): string;
  assistantMessageId(turn: Turn): string;
  /** Optional drawn-message cache. It can reject stale evidence, never grant access. */
  messageRef?(messageId: string): MessageRef | undefined;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid quote.");
  return value as RecordValue;
}
function check(ctx: QuoteSourceContext) {
  if (ctx.current() !== true) throw Error("The quote account changed. Reopen the conversation.");
}
const normalized = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\0/g, "");
const maxText = 1024 * 1024;
function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length > maxText) throw Error("The quoted text is unavailable or too large.");
  return value;
}
interface Candidate { turn: Turn; kind: "user" | "assistant"; branchId: string; active: boolean; logicalId: string; text: string }
function sourceText(ctx: QuoteSourceContext, target: string): { text: string; kind: "user" | "assistant"; source: InlineQuoteSource } {
  const c = ctx.conversation;
  if (!c) throw Error("The quoted message is not in this conversation.");
  const branches = [...(c.savedBranches ?? []).map(b => ({ id: b.id, turns: b.turns, active: false })),
    { id: c.activeBranchId ?? "original", turns: c.turns, active: true }];
  const candidates: Candidate[] = [];
  for (const branch of branches) {
    if (!Array.isArray(branch.turns)) throw Error("The quote history is unavailable.");
    const seen = new Set<string>();
    for (const turn of branch.turns) {
      for (const kind of ["user", "assistant"] as const) {
        const id = kind === "user" ? ctx.userMessageId(turn) : ctx.assistantMessageId(turn);
        if (id !== target) continue;
        const occurrence = JSON.stringify([kind, turn.id]);
        if (seen.has(occurrence)) throw Error("The quoted source contains duplicate turns.");
        seen.add(occurrence);
        let text: string;
        if (kind === "user") text = boundedText(turn.prompt);
        else {
          if (!Array.isArray(turn.items)) throw Error("The quoted reply is unavailable.");
          // Never include thinking, tool arguments/results, files, or client preview.
          text = turn.items.filter(item => (item.type === "text" || item.type === "agentMessage")).map(item => boundedText(item.text ?? "")).join("\n\n");
          boundedText(text);
        }
        candidates.push({ turn, kind, branchId: branch.id, active: branch.active, text,
          logicalId: kind === "user" ? promptKey(turn) : turn.id });
      }
    }
  }
  if (!candidates.length) throw Error("The quoted message is not in this conversation.");
  const first = candidates[0];
  if (candidates.some(row => row.kind !== first.kind || row.logicalId !== first.logicalId || row.text !== first.text))
    throw Error("The quoted message identity is ambiguous.");
  const cached = ctx.messageRef?.(target);
  if (cached && !candidates.some(row => row.turn.id === cached.turnId && row.kind === cached.kind &&
      row.branchId === cached.branchId && row.active === cached.active))
    throw Error("The quoted message reference is stale. Reopen the conversation.");
  check(ctx);
  return { text: first.text, kind: first.kind, source: first.kind === "user" ? { role: "user", promptKey: first.logicalId } : { role: "assistant", turnId: first.logicalId } };
}

/** Whole messages become verified excerpts for the separate pure text normalizer.
 * No target means user-supplied excerpt, not a claim to any stored message. */
export function resolveCompletionQuoteSources(ctx: QuoteSourceContext, quotes: unknown): {
  quotes: unknown[];
  sources: { quoteIndex: number; passageKind: "excerpt" | "wholeMessage"; targetMessageId?: string; source?: InlineQuoteSource }[];
} {
  check(ctx);
  if (!Array.isArray(quotes) || quotes.length > 10) throw Error("Quote at most 10 passages.");
  const sources: { quoteIndex: number; passageKind: "excerpt" | "wholeMessage"; targetMessageId?: string; source?: InlineQuoteSource }[] = [];
  const result = quotes.map((raw, quoteIndex) => {
    const quote = record(raw), passage = record(quote.passage), value = record(passage.value);
    if (passage.case !== "excerpt" && passage.case !== "wholeMessage") throw Error("This quote type is unsupported.");
    const target = value.targetMessageId;
    if (target !== undefined && (typeof target !== "string" || !target || target.length > 512)) throw Error("Invalid quoted message identity.");
    if (passage.case === "wholeMessage" && target === undefined) throw Error("Choose the message to quote.");
    const source = target === undefined ? undefined : sourceText(ctx, target as string);
    const text = passage.case === "wholeMessage" ? source!.text : boundedText(value.text);
    if (!normalized(text).trim()) throw Error("The quoted passage is empty.");
    if (source !== undefined && !normalized(source.text).includes(normalized(text))) {
      // Only assistant Markdown has this bounded visible-text fallback. User
      // prompts retain the existing raw-text contract until their renderer is
      // separately established; an owned ID alone never authorizes attribution.
      const paragraphs = source.kind === "assistant"
        ? completionQuoteVisibleParagraphs(normalized(source.text)) : undefined;
      if (!paragraphs?.some(paragraph => paragraph.includes(normalized(text))))
        throw Error("The quoted passage does not match its source message.");
    }
    sources.push({ quoteIndex, passageKind: passage.case, ...(target === undefined ? {} : { targetMessageId: target as string, source: source!.source }) });
    // Preserve all other fields for the normalizer's strict schema; no implicit
    // acceptance of author/context fields. Whole-message preview is discarded.
    if (passage.case === "wholeMessage") {
      if (Object.keys(passage).some(key => key !== "case" && key !== "value"))
        throw Error("Unsupported whole-message passage field.");
      if (value.$typeName !== undefined && value.$typeName !== "anthropic.bard.api.v1alpha.QuotedMessage")
        throw Error("Unsupported whole-message quote type.");
      if (Object.keys(value).some(key => !["targetMessageId", "preview", "$typeName"].includes(key))) throw Error("Unsupported whole-message quote field.");
      return { ...quote, passage: { case: "excerpt", value: { text, targetMessageId: target } } };
    }
    return { ...quote, passage: { ...passage, value: { ...value, text } } };
  });
  check(ctx);
  return { quotes: result, sources };
}
