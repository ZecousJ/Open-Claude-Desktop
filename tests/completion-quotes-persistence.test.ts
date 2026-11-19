import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompletionQuotes } from "../electron/official-ui/api/completion-quotes";
import { completionQuotesSchema, parsePersistedCompletionQuotes, validateCompletionQuotes } from "../shared/completion-quotes";
const make = () => normalizeCompletionQuotes({ text: "ask 😀\r\n", quotes: [
  { passage: { case: "excerpt", value: { text: "😀\r\n\0line", targetMessageId: "msg_source", prefix: "context", suffix: "after" } }, author: 2, comment: "why?" },
  { passage: { case: "excerpt", value: { text: "second" } } },
] });
const payload = () => { const { text, typedText, quotes } = make(); return { text, typedText, quotes }; };
test("normalizer metadata survives strict prepared and JSON history boundaries without granting ownership", () => {
  const p = payload(), quotes = validateCompletionQuotes(p);
  assert.deepEqual(quotes, p.quotes);
  assert.notEqual(quotes, p.quotes);
  assert.deepEqual(parsePersistedCompletionQuotes(p.text, JSON.parse(JSON.stringify(quotes))), quotes);
  assert.equal(quotes[0].endIndex, Array.from(p.text.slice(0, p.text.indexOf("> second"))).length);
  assert.equal("ownershipValidated" in quotes[0], false);
  assert.throws(() => validateCompletionQuotes(make())); // diagnostics not persisted
});
test("reject forged text, wrong UTF16 indices, overlaps, gaps, reordered and reversed ranges", () => {
  for (const change of [
    (p: ReturnType<typeof payload>) => { p.text = "forged" + p.text; },
    (p: ReturnType<typeof payload>) => { p.quotes[0].endIndex++; },
    (p: ReturnType<typeof payload>) => { p.quotes[1].startIndex--; },
    (p: ReturnType<typeof payload>) => { p.quotes[1].startIndex++; },
    (p: ReturnType<typeof payload>) => { p.quotes.reverse(); },
    (p: ReturnType<typeof payload>) => { p.quotes[0].endIndex = 0; },
    (p: ReturnType<typeof payload>) => { p.typedText = "other"; },
  ]) { const p = payload(); change(p); assert.throws(() => validateCompletionQuotes(p)); }
});
test("reject permission-shaped fields, invalid roles, foreign ID syntax and unsupported passage variants", () => {
  for (const patch of [{ ownershipValidated: true }, { role: "system" }, { author: 4 }, { accountId: "owner" }, { startIndex: NaN }]) {
    const p = payload(); Object.assign(p.quotes[0], patch); assert.throws(() => validateCompletionQuotes(p));
  }
  for (const targetMessageId of ["file:///secret", "../other", "", "msg_" + "x".repeat(253)]) {
    const p = payload(); p.quotes[0].passage.value.targetMessageId = targetMessageId; assert.throws(() => validateCompletionQuotes(p));
  }
  assert.throws(() => completionQuotesSchema.parse([{ passage: { case: "wholeMessage", value: { targetMessageId: "msg_source" } }, startIndex: 0, endIndex: 1 }]));
});
test("history rejects malformed Unicode, noncanonical passages/comments and resource overflow", () => {
  for (const text of ["\ud800", "\udfff", "raw\r\n", "nul\0", " ", "x".repeat(10_001)]) {
    const p = payload(); p.quotes[0].passage.value.text = text; assert.throws(() => parsePersistedCompletionQuotes(p.text, p.quotes));
  }
  const p = payload();
  assert.throws(() => parsePersistedCompletionQuotes("x".repeat(1024 * 1024 + 1), []));
  assert.throws(() => parsePersistedCompletionQuotes("😀".repeat(300_000), []));
  assert.throws(() => completionQuotesSchema.parse(Array(11).fill(p.quotes[0])));
  assert.throws(() => parsePersistedCompletionQuotes(p.text + "\ud800", p.quotes));
  p.quotes[0].comment = "\u001c"; assert.throws(() => completionQuotesSchema.parse(p.quotes));
});
test("empty metadata preserves ordinary prompt and metadata never resolves a syntactically valid source", () => {
  assert.deepEqual(validateCompletionQuotes({ text: "ordinary", typedText: "ordinary", quotes: [] }), []);
  const p = payload(); p.quotes[0].passage.value.targetMessageId = "msg_unverified_other_conversation";
  assert.equal(validateCompletionQuotes(p)[0].passage.value.targetMessageId, "msg_unverified_other_conversation");
  // Acceptance here is syntax only: the caller must resolve and check ownership.
});
