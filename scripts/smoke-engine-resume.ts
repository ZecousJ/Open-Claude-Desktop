/** Real bundled Codex, isolated state and a loopback model; no paid calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { resolveRuntime } from "../electron/engine/runtime";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-resume-smoke-"));
const service = path.join(root, "provider-service.cjs");
const model = "gpt-5.2-codex";
const reply = "RESUME_HISTORY_MARKER " + "saved output ".repeat(60_000);
const inputs: string[] = [];
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  inputs.push(JSON.stringify(body.input));
  const text = inputs.length <= 2 ? reply : "RESUME_OK";
  const item = {
    id: `msg_${inputs.length}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: `resp_${inputs.length}`,
    object: "response",
    status: "completed",
    model,
    output: [item],
    usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
  };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
let store: Store;
let engine: Engine | undefined;
const makeEngine = () => {
  const engine = new Engine(
    store,
    resolveRuntime(),
    () => "loopback-test-key",
    () => {},
    service,
  );
  // Isolate thread recovery from auxiliary title/suggestion model requests.
  engine.sessionAssistance.afterTurn = async () => {};
  engine.titleOffers.afterTurn = async () => {};
  return engine;
};
async function send(text: string, conversationId?: string) {
  const c = await engine!.send({
    text,
    conversationId,
    mode: "code",
    attachments: [],
    providerId: "mock",
    model,
  });
  const deadline = Date.now() + 30_000;
  while (store.conversation(c.id).turns.at(-1)?.status === "inProgress") {
    if (Date.now() > deadline)
      throw Error("The resume smoke turn did not finish");
    await delay(25);
  }
  assert.equal(store.conversation(c.id).turns.at(-1)?.status, "completed");
  return c.id;
}
try {
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: service,
    logLevel: "error",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  store = new Store(root);
  store.settings.providers = [
    {
      id: "mock",
      name: "Loopback",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "responses",
      model,
      models: [model],
    },
  ];
  store.settings.activeProviderId = "mock";
  store.settings.codeSandbox = "read-only";
  engine = makeEngine();
  const id = await send("FIRST_SAVED_PROMPT");
  await send("SECOND_SAVED_PROMPT", id);
  const threadId = store.conversation(id).threadId!;
  await engine.stop();
  store.flush();
  store = new Store(root);
  engine = makeEngine();
  await engine.ensure(store.settings.providers[0]);
  const full = await engine.rpc!.call("thread/resume", { threadId });
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  assert.equal(full.thread.turns.length, 2);
  assert.ok(
    fullBytes > 1_000_000,
    "the test must exercise a large history reply",
  );
  await engine.rpc!.call("thread/unsubscribe", { threadId });
  const call = engine.rpc!.call.bind(engine.rpc);
  let resumedBytes = 0;
  engine.rpc!.call = async (method, params, timeout) => {
    const result = await call(method, params, timeout);
    if (method === "thread/resume") {
      assert.equal(params.excludeTurns, true);
      assert.deepEqual(result.thread.turns, []);
      resumedBytes = Buffer.byteLength(JSON.stringify(result));
    }
    return result;
  };
  await send("CONTINUE_SAVED_PROMPT", id);
  assert.ok(resumedBytes > 0 && resumedBytes < 20_000);
  assert.ok(inputs.at(-1)!.includes("FIRST_SAVED_PROMPT"));
  assert.ok(inputs.at(-1)!.includes("SECOND_SAVED_PROMPT"));
  assert.ok(
    inputs.at(-1)!.includes(reply),
    "model still receives saved assistant history",
  );
  assert.equal(store.conversation(id).threadId, threadId);
  assert.equal(
    store.conversation(id).turns.length,
    3,
    "resume must not duplicate saved turns",
  );
  console.log(
    `PASS real Codex restart/resume: ${fullBytes} → ${resumedBytes} bytes; complete model history and 3 unique turns retained`,
  );
} finally {
  await engine?.stop();
  store!?.flush();
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
