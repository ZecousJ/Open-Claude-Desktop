import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { Engine } from "../../electron/engine/engine";
import { resolveRuntime } from "../../electron/engine/runtime";
import {
  codexCatalogEfforts,
  codexModelCatalog,
} from "../../electron/engine/codex-model-catalog";
import { Store } from "../../electron/store/store";

const model = "gpt-6.1-sol";
function response() {
  const item = {
    id: "msg_effort",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "1", annotations: [] }],
  };
  const completed = {
    id: "resp_effort",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [item],
    usage: {
      input_tokens: 6,
      output_tokens: 1,
      total_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  return [
    {
      type: "response.created",
      response: { ...completed, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: "1",
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ]
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    )
    .join("");
}

test(
  "a published GPT-6 alias forwards the selected effort through the real SDK",
  { timeout: 60_000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "published-effort-wire-"),
    );
    const requests: Record<string, any>[] = [];
    const upstream = http.createServer(async (req, res) => {
      if (req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(parts).toString()));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(response());
    });
    let engine: Engine | undefined;
    let store: Store | undefined;
    t.after(async () => {
      await engine?.stop();
      store?.flush();
      upstream.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as import("node:net").AddressInfo).port;
    const service = path.join(root, "provider-service.cjs");
    await build({
      entryPoints: ["server/provider-service.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      outfile: service,
    });
    store = new Store(path.join(root, "profile"));
    store.settings.providers = [
      {
        id: "mock",
        name: "Local effort fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        protocol: "responses",
        model,
        models: [model],
      },
    ];
    store.settings.activeProviderId = "mock";
    engine = new Engine(
      store,
      resolveRuntime(),
      () => "synthetic-key",
      () => {},
      service,
    );
    let published: string[] | undefined;
    engine.modelEfforts = (_provider, requested) =>
      requested === model ? published : undefined;
    async function sendAndCapture(text: string, effort?: "xhigh") {
      const c = await engine!.send({
        text,
        mode: "chat",
        attachments: [],
        providerId: "mock",
        model,
        effort,
      });
      const until = Date.now() + 20_000;
      while (
        store!.conversation(c.id).turns.at(-1)?.status === "inProgress" &&
        Date.now() < until
      )
        await new Promise((r) => setTimeout(r, 30));
      const turn = store!.conversation(c.id).turns.at(-1)!;
      assert.equal(turn.status, "completed", turn.error);
      const sent = requests.find(
        (r) => r.model === model && JSON.stringify(r.input).includes(text),
      );
      assert.ok(sent, "the actual SDK sent the fixture turn");
      return sent;
    }
    const unknown = await sendAndCapture("EFFORT_WIRE_UNDECLARED");
    assert.equal(unknown.reasoning?.effort, undefined);
    published = ["low", "medium", "high", "xhigh", "max"];
    const sent = await sendAndCapture("EFFORT_WIRE_PUBLISHED", "xhigh");
    assert.equal(sent.reasoning?.effort, "xhigh");
    assert.equal(sent.reasoning?.summary, undefined);
  },
);

test("an available sibling alias does not inherit a different model's published effort support", () => {
  const modelEfforts = codexCatalogEfforts(
    ["grok-4.6", "grok-4.6-latest"],
    [{ model: "grok-4.6", efforts: ["high"] }],
  );
  const { models } = codexModelCatalog({ modelEfforts });
  const declared = models.find((entry) => entry.slug === "grok-4.6");
  const sibling = models.find((entry) => entry.slug === "grok-4.6-latest");
  assert.equal(declared?.supports_reasoning_summaries, true);
  assert.deepEqual(declared?.supported_reasoning_levels, [
    { effort: "high", description: "" },
  ]);
  assert.equal(sibling?.supports_reasoning_summaries, false);
  assert.deepEqual(sibling?.supported_reasoning_levels, []);
});
