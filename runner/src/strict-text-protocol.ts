/** Candidate Chat protocol subset only. Pure bytes/objects; no transport, authority or executor. */
export class StrictTextProtocolError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_stream" | "refused" | "aborted" | "limit", message: string) { super(message); }
}
const fail = (code: StrictTextProtocolError["code"], message: string): never => { throw new StrictTextProtocolError(code, message); };
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    return fail("invalid_request", "Unsupported candidate text schema.");
  return value as Record<string, any>;
}
const integer = (v: unknown, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
/** This is a structural plan, NOT an authenticated spending permit. The future
 * executor must verify its centralized authority, prices and provider hard cap. */
export function buildCandidateChatRequest(input: unknown, plan: unknown) {
  const v = object(input, ["protocol", "model", "messages", "operationKey", "payloadHash"]);
  const p = object(plan, ["operationKey", "payloadHash", "model", "maxOutputTokens"]);
  if (v.protocol !== "chat" || typeof v.model !== "string" || !v.model || v.model.length > 256 ||
      !hash(v.operationKey) || !hash(v.payloadHash) || p.operationKey !== v.operationKey || p.payloadHash !== v.payloadHash || p.model !== v.model || !integer(p.maxOutputTokens, 32768) ||
      !Array.isArray(v.messages) || !v.messages.length || v.messages.length > 256)
    fail("invalid_request", "Invalid candidate text request or structural limit plan.");
  let bytes = 0;
  const messages = v.messages.map((raw: unknown) => {
    const m = object(raw, ["role", "content"]);
    if (!["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") fail("invalid_request", "Only textual context is supported.");
    bytes += Buffer.byteLength(m.content, "utf8");
    if (bytes > 256 * 1024) fail("limit", "Candidate context is too large.");
    return { role: m.role as "system" | "user" | "assistant", content: m.content as string };
  });
  return { route: "/chat/completions" as const, body: { model: v.model as string, messages, stream: true, n: 1, max_completion_tokens: p.maxOutputTokens as number } };
}
export type CandidateChatEvent = { type: "text"; text: string } | { type: "finished"; truncated: boolean };
export interface CandidateChatResult { text: string; truncated: boolean; usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null }
/** Strict finite stream parser. Call finish() at EOF; incomplete/aborted streams
 * never become successful results. Callers must not retry a dispatched request. */
export class CandidateChatStream {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private data: string[] = [];
  private eventBytes = 0;
  private totalBytes = 0;
  private text = "";
  private terminal: "stop" | "length" | undefined;
  private done = false;
  private ended = false;
  private usage: CandidateChatResult["usage"] = null;
  private identity?: string;
  private readonly limits: Readonly<{maxStreamBytes: number; maxEventBytes: number; maxTextBytes: number}>;
  constructor(limits = { maxStreamBytes: 1024 * 1024, maxEventBytes: 64 * 1024, maxTextBytes: 512 * 1024 }) {
    const keys = ["maxStreamBytes", "maxEventBytes", "maxTextBytes"];
    const source = object(limits, keys);
    const captured = {maxStreamBytes: source.maxStreamBytes, maxEventBytes: source.maxEventBytes, maxTextBytes: source.maxTextBytes};
    for (const key of keys) if (!Object.hasOwn(source, key)) fail("invalid_request", "Invalid parser bounds.");
    for (const v of Object.values(captured)) if (!integer(v, 4 * 1024 * 1024)) fail("invalid_request", "Invalid parser bounds.");
    this.limits = Object.freeze(captured);
  }
  private invalid(message = "Unsupported or incomplete candidate text stream."): never { this.ended = true; return fail("invalid_stream", message); }
  private frame(events: CandidateChatEvent[]) {
    const data = this.data.join("\n"); this.data = []; this.eventBytes = 0;
    if (!data) return;
    if (this.done) this.invalid("Data after stream completion.");
    if (data === "[DONE]") {
      if (!this.terminal) this.invalid("Stream ended without a text finish reason.");
      this.done = true; events.push({ type: "finished", truncated: this.terminal === "length" }); return;
    }
    let v: any;
    try { v = JSON.parse(data); } catch { this.invalid("Invalid stream JSON."); }
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["id", "object", "created", "model", "system_fingerprint", "service_tier", "choices", "usage"].includes(k)) || !Array.isArray(v.choices) || v.choices.length > 1) this.invalid();
    if (v.object !== undefined && v.object !== "chat.completion.chunk") this.invalid();
    if (v.id !== undefined) { if (typeof v.id !== "string" || !v.id || v.id.length > 256 || this.identity && this.identity !== v.id) this.invalid(); this.identity = v.id; }
    if (v.usage != null) {
      const u = v.usage;
      if (this.usage || typeof u !== "object" || Array.isArray(u) || Object.keys(u).some(k => !["prompt_tokens", "completion_tokens", "total_tokens"].includes(k)) || ![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0) || u.total_tokens !== u.prompt_tokens + u.completion_tokens) this.invalid("Unsupported usage metadata.");
      this.usage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens };
    }
    if (!v.choices.length) { if (!this.terminal || v.usage == null) this.invalid(); return; }
    if (this.terminal) this.invalid("Text choice after finish reason.");
    const c = v.choices[0];
    if (!c || typeof c !== "object" || Object.keys(c).some(k => !["index", "delta", "finish_reason", "logprobs"].includes(k)) || c.index !== 0 || c.logprobs != null || !c.delta || typeof c.delta !== "object" || Array.isArray(c.delta)) this.invalid();
    const d = c.delta;
    if (Object.keys(d).some(k => !["role", "content", "refusal"].includes(k)) || d.role !== undefined && d.role !== "assistant") this.invalid("Non-text output is unsupported.");
    if (d.refusal != null) { if (typeof d.refusal !== "string") this.invalid(); if (d.refusal) { this.ended = true; fail("refused", "The model refused the candidate text request."); } }
    if (d.content != null) {
      if (typeof d.content !== "string") this.invalid();
      if (Buffer.byteLength(this.text, "utf8") + Buffer.byteLength(d.content, "utf8") > this.limits.maxTextBytes) { this.ended = true; fail("limit", "Candidate text exceeds parser bounds."); }
      this.text += d.content; if (d.content) events.push({ type: "text", text: d.content });
    }
    if (c.finish_reason != null) { if (!["stop", "length"].includes(c.finish_reason)) this.invalid("Unsupported finish reason."); this.terminal = c.finish_reason; }
  }
  private lines(final: boolean): CandidateChatEvent[] {
    const events: CandidateChatEvent[] = [];
    while (this.buffer.length) {
      const at = this.buffer.search(/[\r\n]/);
      if (at < 0) break;
      if (!final && at === this.buffer.length - 1 && this.buffer[at] === "\r") break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + (this.buffer[at] === "\r" && this.buffer[at + 1] === "\n" ? 2 : 1));
      this.eventBytes += Buffer.byteLength(line, "utf8") + 1;
      if (this.eventBytes > this.limits.maxEventBytes) { this.ended = true; fail("limit", "Candidate event exceeds parser bounds."); }
      if (!line) this.frame(events);
      else if (line.startsWith(":")) { /* bounded SSE comment */ }
      else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
      else this.invalid("Unsupported SSE field.");
    }
    if (this.eventBytes + Buffer.byteLength(this.buffer, "utf8") > this.limits.maxEventBytes) { this.ended = true; fail("limit", "Candidate line exceeds parser bounds."); }
    return events;
  }
  push(bytes: Uint8Array): CandidateChatEvent[] {
    if (this.ended) this.invalid("Parser is closed.");
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > this.limits.maxStreamBytes) { this.ended = true; fail("limit", "Candidate stream exceeds parser bounds."); }
    try { this.buffer += this.decoder.decode(bytes, { stream: true }); } catch { this.invalid("Invalid stream UTF-8."); }
    return this.lines(false);
  }
  finish(): CandidateChatResult {
    if (this.ended) this.invalid("Parser is closed.");
    try { this.buffer += this.decoder.decode(); } catch { this.invalid("Truncated stream UTF-8."); }
    this.lines(true);
    if (this.buffer || this.data.length || !this.done) this.invalid("Stream ended before its complete terminal frame.");
    this.ended = true; return { text: this.text, truncated: this.terminal === "length", usage: this.usage };
  }
  abort(): void { this.ended = true; this.buffer = ""; this.data = []; this.text = ""; fail("aborted", "Candidate stream was aborted; delivery remains unknown."); }
}
