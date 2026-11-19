import test from "node:test";
import assert from "node:assert/strict";
import { resolveCompletionQuoteSources as resolve, type QuoteSourceContext } from "../electron/official-ui/api/completion-quote-source";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { userMessageId, assistantMessageId, turnMessageIds } from "../electron/official-ui/api/conversations";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
import { normalizeCompletionQuotes } from "../electron/official-ui/api/completion-quotes";
const turn = (id = "t"): any => ({ id, prompt: "User prompt", items: [
  { id: "thought", type: "thinking", text: "PRIVATE_THOUGHT" },
  { id: "a", type: "text", text: "Hello 😀\n世界" },
  { id: "tool", type: "tool", text: "PRIVATE_TOOL", result: "PRIVATE_RESULT" },
  { id: "b", type: "text", text: "Second paragraph" },
], attachments: [{ name: "PRIVATE_FILE" }] });
const context = (): QuoteSourceContext => ({ conversation: { id: "owned", turns: [turn()], savedBranches: [] } as any,
  current: () => true, userMessageId: t => `${t.promptVersionId ?? t.responseGroupId ?? t.id}:user`, assistantMessageId: t => `${t.id}:assistant` });
const excerpt = (text = "😀\n世界", targetMessageId?: string): any => ({ passage: { case: "excerpt", value: { text, ...(targetMessageId === undefined ? {} : { targetMessageId }) } }, comment: "My comment" });
const whole = (id: string): any => ({ passage: { case: "wholeMessage", value: { targetMessageId: id, preview: "FAKE_PRIVATE_PREVIEW" } } });
test("targetless excerpt requires no conversation and preserves explicit Unicode/comment without granting a source", () => {
  const ctx = context(); delete ctx.conversation;
  const q = excerpt(); const before = structuredClone(q); const result = resolve(ctx, [q]);
  assert.deepEqual(result.quotes, [q]); assert.deepEqual(q, before);
  assert.deepEqual(result.sources, [{ quoteIndex: 0, passageKind: "excerpt" }]);
});
test("whole source uses only exact user prompt or assistant text, ignores preview and preserves source kind", () => {
  const ctx = context(), before = structuredClone(ctx.conversation);
  const result = resolve(ctx, [whole("t:assistant"), whole("t:user")]);
  assert.equal((result.quotes[0] as any).passage.value.text, "Hello 😀\n世界\n\nSecond paragraph");
  assert.equal((result.quotes[1] as any).passage.value.text, "User prompt");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(result.sources[0].passageKind, "wholeMessage"); assert.deepEqual(ctx.conversation, before);
});
test("targeted excerpt checks canonical source including Unicode but never invents rendered Markdown equivalence", () => {
  const ctx = context(); ctx.conversation!.turns[0].items[1].text = "Hello 😀\r\n世\0界 **bold**";
  assert.equal(resolve(ctx, [excerpt("😀\n世界", "t:assistant")]).quotes.length, 1);
  assert.throws(() => resolve(ctx, [excerpt("世界 bold", "t:assistant")]), /does not match/);
  assert.throws(() => resolve(ctx, [excerpt("PRIVATE_THOUGHT", "t:assistant")]), /does not match/);
});
test("foreign ID and lying cache cannot authorize source; stale cache cannot select unrelated turn", () => {
  const ctx = context(); ctx.messageRef = () => ({turnId:"t",kind:"assistant",branchId:"original",active:true});
  assert.throws(() => resolve(ctx, [whole("foreign:assistant")]), /not in this conversation/);
  ctx.messageRef = () => ({turnId:"other",kind:"assistant",branchId:"original",active:true});
  assert.throws(() => resolve(ctx, [whole("t:assistant")]), /stale/);
});
test("saved branches are valid owned sources; identical shared prompt versions deduplicate, conflicts refuse", () => {
  const ctx = context(), old = turn("old"); old.promptVersionId = "shared";
  ctx.conversation!.turns[0].promptVersionId = "shared";
  ctx.conversation!.savedBranches = [{id:"saved",turns:[old]}] as any;
  assert.equal(resolve(ctx, [whole("old:assistant"), whole("shared:user")]).quotes.length, 2);
  old.prompt = "Conflicting prompt";
  assert.throws(() => resolve(ctx, [whole("shared:user")]), /ambiguous/);
});
test("duplicate turns, colliding stable IDs and duplicate content identities refuse", () => {
  const ctx = context(); ctx.conversation!.turns.push(turn());
  assert.throws(() => resolve(ctx, [whole("t:assistant")]), /duplicate/);
  ctx.conversation!.turns = [turn("a"), turn("b")]; ctx.assistantMessageId = () => "same";
  assert.throws(() => resolve(ctx, [whole("same")]), /ambiguous/);
});
test("retirement before resolution or during callback yields no result, including same-owner activation veto", () => {
  const ctx = context(); let current = false; ctx.current = () => current;
  assert.throws(() => resolve(ctx, [excerpt()]), /account changed/);
  current = true; ctx.messageRef = () => { current = false; return undefined; };
  assert.throws(() => resolve(ctx, [whole("t:assistant")]), /account changed/);
});
test("does not trust author or preview; unsupported fields remain for strict downstream validation", () => {
  const ctx = context(); const q = { ...excerpt("Hello", "t:assistant"), author: 999 };
  assert.equal((resolve(ctx, [q]).quotes[0] as any).author, 999);
  assert.throws(() => resolve(ctx, [{passage:{case:"wholeMessage",value:{preview:"not a source"}}}]), /Choose the message/);
  assert.throws(() => resolve(ctx, [{passage:{case:"wholeMessage",value:{targetMessageId:"t:user",path:"private"}}}]), /Unsupported/);
  assert.throws(() => resolve(ctx, [{passage:{...whole("t:user").passage,unexpected:"must not disappear"}}]), /Unsupported whole-message passage/);
  assert.throws(() => resolve(ctx, Array.from({length:11},()=>excerpt())), /10 passages/);
});
test("real protobuf decoded excerpt/whole resolve source without mistaking default author for authority", () => {
  const schema = loadRegistry("build/official-ui/data/conversation-protocol.json").getMessage("anthropic.bard.api.v1alpha.Quote")!;
  const decoded = [excerpt("Hello", "t:assistant"), whole("t:user")].map(q => fromBinary(schema, toBinary(schema, deepCreate(schema, q))));
  const result = resolve(context(), decoded);
  assert.equal((result.quotes[0] as any).author, 0);
  assert.equal((result.quotes[1] as any).passage.value.text, "User prompt");
  assert.equal(result.sources[1].passageKind, "wholeMessage");
});
test("actual account-scoped ID exports support the pure resolver → normalizer sequence", () => {
  inAdapterScope(newAdapterScope("source-owner"), () => {
    turnMessageIds.set("t", {user:"msg_user",assistant:"msg_assistant"});
    const ctx = {...context(),userMessageId,assistantMessageId};
    const result = resolve(ctx, [whole("msg_assistant")]);
    const prepared = normalizeCompletionQuotes({text:"My question",quotes:result.quotes});
    assert.equal(prepared.quotes[0].passage.value.targetMessageId,"msg_assistant");
    assert.equal(result.sources[0].passageKind,"wholeMessage");
    assert.equal(prepared.text.includes("PRIVATE"),false);
  });
  inAdapterScope(newAdapterScope("other-owner"), () => {
    assert.throws(() => resolve({...context(),userMessageId,assistantMessageId},[whole("msg_assistant")]),/not in this conversation/);
  });
});
test("unrelated long history or duplicate unrelated rows do not impose a new quote-history limit", () => {
  const ctx = context();
  ctx.conversation!.savedBranches = Array.from({length:201},(_,i)=>({id:`branch-${i}`,turns:[turn(`old-${i}`)]})) as any;
  ctx.conversation!.turns.push(...Array.from({length:10001},()=>turn("unrelated")));
  assert.equal(resolve(ctx,[excerpt("Hello","t:assistant")]).quotes.length,1);
});
