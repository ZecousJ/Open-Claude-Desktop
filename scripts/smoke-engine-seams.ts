/**
 * E0 engine seams against the real bundled Codex app-server: /compact,
 * steering, the full ThreadTokenUsage and the catalog's context limits.
 * Isolated state and a loopback mock model service; no credentials, no paid
 * calls. Run: npx tsx scripts/smoke-engine-seams.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { resolveRuntime } from "../electron/engine/runtime";
import { isSteeredMessage } from "../shared/agent-api";
import type { Conversation } from "../shared/types";

type Json = Record<string, any>;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-e0-smoke-"));
const providerServiceScript = path.join(root, "provider-service.cjs");
const model = "gpt-5.2-codex";
const smallModel = "claudex-small-window";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, ms = 25_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}

/** What the mock model service saw, newest last. */
const requests: { model: string; text: string; compaction: boolean }[] = [];
let inputTokens = 30;
let holdNext = false;
let release: (() => void) | undefined;
function stream(res: http.ServerResponse, text: string, requested: string) {
  const n = requests.length;
  const message = {
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: `resp_${n}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requested,
    output: [message],
    usage: {
      input_tokens: inputTokens,
      output_tokens: 8,
      total_tokens: inputTokens + 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events: Json[] = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  events.forEach((event, sequence_number) =>
    res.write(
      `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    ),
  );
  res.end();
}
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const text = JSON.stringify(body.input ?? []);
  // Codex's summarization prompt closes the compaction request.
  const compaction = /Be concise, structured, and focused/.test(
    text.slice(-2000),
  );
  requests.push({ model: body.model, text, compaction });
  if (holdNext) {
    holdNext = false;
    await new Promise<void>((resolve) => (release = resolve));
  }
  stream(
    res,
    compaction ? "E0_SUMMARY" : `E0_REPLY_${requests.length}`,
    body.model,
  );
});

let engine: Engine | undefined;
let store: Store | undefined;
const last = (id: string) => store!.conversation(id).turns.at(-1)!;
async function settled(id: string) {
  await until(() => last(id).status !== "inProgress", "turn end");
  return last(id);
}
async function send(text: string, conversationId?: string, as = model) {
  return engine!.send({
    text,
    conversationId,
    mode: "code",
    attachments: [],
    providerId: "mock",
    model: as,
  });
}

try {
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: providerServiceScript,
    logLevel: "error",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  store = new Store(root);
  store.settings.providers = [
    {
      id: "mock",
      name: "Local smoke mock",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "responses",
      model,
      models: [model, smallModel],
    },
  ];
  store.settings.activeProviderId = "mock";
  store.settings.sandbox = "workspace-write";
  store.settings.codeSandbox = "read-only";
  engine = new Engine(
    store,
    resolveRuntime(),
    () => "local-smoke-key-not-a-real-credential",
    () => {},
    providerServiceScript,
  );

  // 1. The full ThreadTokenUsage reaches the conversation.
  const c: Conversation = await send("E0_HELLO");
  const first = await settled(c.id);
  assert.equal(first.status, "completed");
  let usage = store.conversation(c.id).tokenUsage;
  assert(usage, "tokenUsage recorded");
  assert.equal(usage.last.totalTokens, 38);
  assert.equal(usage.total.totalTokens, 38);
  assert.equal(usage.modelContextWindow, 258_400);
  console.log(
    `PASS token usage: last ${usage.last.totalTokens}, window ${usage.modelContextWindow} (${engine.state.version})`,
  );

  // 2. /compact runs as its own turn and leaves the previous turn alone.
  const firstId = first.id;
  await engine.compactConversation(c.id);
  const compaction = await settled(c.id);
  assert.equal(compaction.compaction, "manual");
  assert.equal(compaction.status, "completed", compaction.error);
  assert.notEqual(compaction.id, firstId);
  assert(!compaction.id.startsWith("pending-"));
  assert.equal(store.conversation(c.id).turns[0].id, firstId);
  assert.deepEqual(
    compaction.items.map((item) => item.type),
    ["contextCompaction"],
  );
  assert(requests.at(-1)!.compaction, "summarization request reached the mock");
  usage = store.conversation(c.id).tokenUsage!;
  assert.equal(usage.last.inputTokens, 0);
  console.log(
    `PASS /compact: turn ${compaction.id.slice(0, 8)}…, context after ${usage.last.totalTokens} tokens`,
  );

  // 3. A steered message joins the running turn when the model reads it.
  holdNext = true;
  await send("E0_SECOND", c.id);
  await until(() => Boolean(release), "request held");
  const steered = await engine.steerTurn(c.id, "E0_STEERED", []);
  assert(steered, "steer accepted");
  release!();
  release = undefined;
  const second = await settled(c.id);
  assert.equal(second.status, "completed", second.error);
  const message = second.items.find(isSteeredMessage);
  assert(message, JSON.stringify(second.items.map((i) => i.type)));
  assert.equal(message.clientId, steered.messageId);
  assert.equal(message.text, "E0_STEERED");
  assert.deepEqual(
    second.items.map((item) => item.type),
    ["agentMessage", "userMessage", "agentMessage"],
  );
  assert(requests.at(-1)!.text.includes("E0_STEERED"));
  assert.equal(await engine.steerTurn(c.id, "E0_IDLE", []), null);
  console.log("PASS steer: delivered between the two replies of one turn");

  // 4. A steer still waiting when the turn is stopped is never sent.
  holdNext = true;
  await send("E0_THIRD", c.id);
  await until(() => Boolean(release), "request held");
  const dropped = await engine.steerTurn(c.id, "E0_DROPPED", []);
  assert(dropped);
  await engine.interrupt(c.id);
  release!();
  release = undefined;
  const third = await settled(c.id);
  assert.equal(third.status, "interrupted");
  assert(!third.items.some(isSteeredMessage));
  await send("E0_FOURTH", c.id);
  await settled(c.id);
  assert(!requests.at(-1)!.text.includes("E0_DROPPED"));
  console.log("PASS steer: dropped with an interrupted turn, never sent");

  // 5. The catalog's limits reach Codex: a small window and threshold.
  engine.modelLimits = (_provider, name) =>
    name === smallModel
      ? { contextWindow: 100_000, autoCompactTokens: 1_000 }
      : undefined;
  inputTokens = 2_000;
  const small = await send("E0_SMALL_ONE", undefined, smallModel);
  await settled(small.id);
  usage = store.conversation(small.id).tokenUsage!;
  assert.equal(usage.modelContextWindow, 95_000);
  inputTokens = 30;
  await send("E0_SMALL_TWO", small.id, smallModel);
  const auto = await settled(small.id);
  assert.deepEqual(
    auto.items.map((item) => item.type),
    ["contextCompaction", "agentMessage"],
  );
  console.log(
    `PASS limits: window ${usage.modelContextWindow}, compacted before the next turn at 1,000 tokens`,
  );

  // 6. Switching a loaded conversation to a model with other limits.
  inputTokens = 2_000;
  const switched = await send("E0_SWITCH_ONE");
  await settled(switched.id);
  const compactionsBefore = requests.filter((r) => r.compaction).length;
  inputTokens = 30;
  await send("E0_SWITCH_TWO", switched.id, smallModel);
  const afterSwitch = await settled(switched.id);
  assert.equal(afterSwitch.items[0]?.type, "contextCompaction");
  assert.equal(
    requests.filter((r) => r.compaction).length,
    compactionsBefore + 1,
  );
  assert.equal(
    store.conversation(switched.id).tokenUsage?.modelContextWindow,
    95_000,
  );
  console.log("PASS limits: a model switch loads the thread with its limits");
} finally {
  await engine?.stop();
  server.close();
  store?.flush();
  await delay(200);
  fs.rmSync(root, { recursive: true, force: true });
}
