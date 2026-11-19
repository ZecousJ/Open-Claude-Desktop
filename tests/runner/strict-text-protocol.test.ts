/** Self-authored inert protocol bytes only: no HTTP, provider or executor. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateChatRequest, CandidateChatStream, StrictTextProtocolError } from "../../runner/src/strict-text-protocol";
const key = "a".repeat(64), digest = "b".repeat(64);
const input = () => ({ protocol: "chat", model: "inert-model", operationKey: key, payloadHash: digest, messages: [{ role: "system", content: "Inert fixture" }, { role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }] });
const plan = () => ({ operationKey: key, payloadHash: digest, model: "inert-model", maxOutputTokens: 32 });
const bytes = (s: string) => new TextEncoder().encode(s);
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const choice = (delta: any, finish_reason: any = null) => ({ id: "inert-response", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
const end = frame(choice({}, "stop")) + "data: [DONE]\n\n";
function throwsCode(fn: () => unknown, code: string) { assert.throws(fn, e => e instanceof StrictTextProtocolError && e.code === code); }
test("candidate builder serializes only text and a bound structural output limit, not authorization", () => {
  const result = buildCandidateChatRequest(input(), plan());
  assert.deepEqual(Object.keys(result.body).sort(), ["max_completion_tokens", "messages", "model", "n", "stream"]);
  assert.equal(result.route, "/chat/completions"); assert.equal(result.body.max_completion_tokens, 32);
  assert.equal(result.body.n, 1); assert.equal(result.body.messages[2].role, "assistant");
});
test("builder rejects tools/attachments/unknown protocol and unbound or invalid structural plans", () => {
  for (const patch of [{ tools: [] }, { attachments: [] }, { protocol: "responses" }, { messages: [{ role: "tool", content: "no" }] }, { messages: [{ role: "user", content: [{ type: "image_url" }] }] }, { messages: [{ role: "user", content: "x", tool_calls: [] }] }]) throwsCode(() => buildCandidateChatRequest({ ...input(), ...patch }, plan()), "invalid_request");
  for (const maxOutputTokens of [0, -1, 1.5, Infinity, NaN, 32769, "32"]) throwsCode(() => buildCandidateChatRequest(input(), { ...plan(), maxOutputTokens }), "invalid_request");
  for (const patch of [{ model: "other" }, { operationKey: digest }, { payloadHash: key }, { approved: true }]) throwsCode(() => buildCandidateChatRequest(input(), { ...plan(), ...patch }), "invalid_request");
  throwsCode(() => buildCandidateChatRequest({ ...input(), messages: [{ role: "user", content: "x".repeat(262145) }] }, plan()), "limit");
});
test("split UTF8 and CRLF preserve text; missing usage remains unknown", () => {
  const p = new CandidateChatStream(), events: any[] = [];
  const wire = (frame(choice({ role: "assistant", content: "你好🙂" })) + end).replace(/\n/g, "\r\n");
  for (const b of bytes(wire)) events.push(...p.push(new Uint8Array([b])));
  assert.deepEqual(p.finish(), { text: "你好🙂", truncated: false, usage: null });
  assert.deepEqual(events, [{ type: "text", text: "你好🙂" }, { type: "finished", truncated: false }]);
});
test("length finish is explicitly truncated and usage is validated without fabricated totals", () => {
  const p = new CandidateChatStream();
  p.push(bytes(frame(choice({ content: "partial" }, "length")) + frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + "data: [DONE]\n\n"));
  assert.deepEqual(p.finish(), { text: "partial", truncated: true, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  for (const usage of [{}, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 4 }, { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }]) {
    const bad = new CandidateChatStream(); throwsCode(() => bad.push(bytes(frame({ choices: [], usage }))), "invalid_stream");
  }
});
test("tools/function/audio/unknown delta and multiple choices cannot become text success", () => {
  for (const delta of [{ tool_calls: [] }, { function_call: {} }, { audio: {} }, { role: "tool" }, { content: [] }, { unexpected: true }]) {
    const p = new CandidateChatStream(); throwsCode(() => p.push(bytes(frame(choice(delta)))), "invalid_stream");
  }
  const p = new CandidateChatStream(); throwsCode(() => p.push(bytes(frame({ choices: [choice({}).choices[0], choice({}).choices[0]] }))), "invalid_stream");
});
test("refusal has an explicit terminal error and never succeeds", () => {
  const p = new CandidateChatStream(); throwsCode(() => p.push(bytes(frame(choice({ refusal: "Self-authored refusal" })))), "refused");
  throwsCode(() => p.finish(), "invalid_stream");
});
test("duplicate DONE, text after terminal and incomplete EOF are errors", () => {
  for (const wire of [end + "data: [DONE]\n\n", end + frame(choice({ content: "late" })), frame(choice({}, "stop")) + frame(choice({ content: "late" })), "data: [DONE]\n\n"]) {
    const p = new CandidateChatStream(); throwsCode(() => p.push(bytes(wire)), "invalid_stream");
  }
  for (const wire of ["", frame(choice({ content: "partial" })), frame(choice({}, "stop")), "data: [DONE]"]) {
    const p = new CandidateChatStream(); p.push(bytes(wire)); throwsCode(() => p.finish(), "invalid_stream");
  }
});
test("malformed/truncated UTF8 and abort poison parser rather than yielding success", () => {
  const p = new CandidateChatStream(); throwsCode(() => p.push(new Uint8Array([255])), "invalid_stream");
  const q = new CandidateChatStream(); q.push(new Uint8Array([0xe4])); throwsCode(() => q.finish(), "invalid_stream");
  const r = new CandidateChatStream(); r.push(bytes(frame(choice({ content: "partial" })))); throwsCode(() => r.abort(), "aborted"); throwsCode(() => r.push(bytes(end)), "invalid_stream");
});
test("stream, event and text limits are independently bounded", () => {
  const a = new CandidateChatStream({ maxStreamBytes: 8, maxEventBytes: 8, maxTextBytes: 8 }); throwsCode(() => a.push(bytes("x".repeat(9))), "limit");
  const b = new CandidateChatStream({ maxStreamBytes: 1000, maxEventBytes: 8, maxTextBytes: 8 }); throwsCode(() => b.push(bytes("data: abcdef")), "limit");
  const c = new CandidateChatStream({ maxStreamBytes: 1000, maxEventBytes: 500, maxTextBytes: 2 }); throwsCode(() => c.push(bytes(frame(choice({ content: "abc" })))), "limit");
  const d = new CandidateChatStream(); throwsCode(() => d.push(bytes("event: tool\n\n")), "invalid_stream");
});
test("parser bounds require all exact fields and cannot change after construction", () => {
  for (const invalid of [{}, {maxStreamBytes: 20}, {maxStreamBytes:20,maxEventBytes:20,maxTextBytes:20,unknown:1},null])
    throwsCode(() => new CandidateChatStream(invalid as never), "invalid_request");
  const limits={maxStreamBytes:1000,maxEventBytes:500,maxTextBytes:2};
  const p=new CandidateChatStream(limits); limits.maxTextBytes=1000;
  throwsCode(()=>p.push(bytes(frame(choice({content:'abc'})))), 'limit');
});
