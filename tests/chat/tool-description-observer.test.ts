import test from "node:test";
import assert from "node:assert/strict";
import { toolDescriptionFromResponse } from "../../server/tool-descriptions";
import {
  maxDescriptionLength,
  sanitizeDescription,
} from "../../shared/tool-description";
import {
  parseToolDescriptionSignal,
  type ToolDescriptionEvent,
  type WebSourcesEvent,
} from "../../shared/gateway-signals";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import type { Provider } from "../../shared/types";

test("descriptions and sources cross from the provider service child to the main process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-s1-signals-"));
  const script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
    logLevel: "silent",
  });
  const bodies: any[] = [];
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" }).end(
      frame({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_1",
          arguments: JSON.stringify({
            cmd: "ls",
            description: "List\u202e repository files",
          }),
        },
      }) +
        frame({
          type: "response.output_item.done",
          item: {
            id: "ws_1",
            type: "web_search_call",
            action: { query: "q", sources: [{ url: "https://a.example/" }] },
          },
        }) +
        frame({ type: "response.completed", response: { id: "r" } }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as { port: number }).port;
  const provider: Provider = {
    id: "fixture",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: "responses",
    model: "grok-4",
    models: [],
  };
  const descriptions: ToolDescriptionEvent[] = [];
  const sources: WebSourcesEvent[] = [];
  const client = new ProviderServiceClient(
    script,
    root,
    provider,
    "synthetic-upstream-secret",
    undefined,
    root,
    undefined,
    undefined,
    undefined,
    {
      onToolDescription: (event) => descriptions.push(event),
      onWebSources: (event) => sources.push(event),
    },
    { describeTools: true, xSearchModels: [] },
  );
  try {
    const url = await client.start();
    const post = async () => {
      const response = await fetch(`${url}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${client.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-4",
          client_metadata: { thread_id: "thread-1" },
          input: "hi",
          tools: [
            {
              type: "function",
              name: "exec_command",
              parameters: { type: "object", properties: {}, required: [] },
            },
            { type: "web_search" },
          ],
        }),
      });
      await response.text();
    };
    await post();
    for (let i = 0; i < 100 && (!descriptions.length || !sources.length); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(descriptions, [
      {
        threadId: "thread-1",
        callId: "call_1",
        description: "List repository files",
      },
    ]);
    assert.equal(sources[0]?.kind, "search");
    assert.deepEqual(bodies[0].tools[0].parameters.required, ["description"]);
    assert.equal(
      bodies[0].tools.some((tool: any) => tool.type === "x_search"),
      false,
    );
    await client.setRequestOptions({
      describeTools: false,
      xSearchModels: ["grok-4"],
    });
    await post();
    assert.deepEqual(bodies[1].tools[0].parameters.required, []);
    assert.deepEqual(bodies[1].tools.at(-1), { type: "x_search" });
    await assert.rejects(
      client.setRequestOptions({ describeTools: "yes" } as any),
      /Invalid request options/,
    );
  } finally {
    await client.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const done = (item: Record<string, unknown>) => ({
  type: "response.output_item.done",
  item: {
    type: "function_call",
    name: "exec_command",
    call_id: "call_1",
    arguments: JSON.stringify({
      cmd: "ls",
      description: "List repository files",
    }),
    ...item,
  },
});

test("a finished shell call yields its description for the request's thread", () => {
  assert.deepEqual(toolDescriptionFromResponse(done({}), "thread-1"), {
    threadId: "thread-1",
    callId: "call_1",
    description: "List repository files",
  });
  for (const name of ["shell_command", "shell"])
    assert.equal(
      toolDescriptionFromResponse(done({ name }), "t")?.description,
      "List repository files",
    );
});

test("other events, tools and malformed calls are ignored", () => {
  const ignored = [
    [done({}), undefined],
    [done({}), ""],
    [done({}), "x".repeat(501)],
    [{ ...done({}), type: "response.output_item.added" }, "t"],
    [done({ type: "custom_tool_call" }), "t"],
    [done({ name: "spawn_agent" }), "t"],
    [done({ name: "exec_command", namespace: "multi_agent_v1" }), "t"],
    [done({ call_id: "" }), "t"],
    [done({ call_id: "c".repeat(501) }), "t"],
    [done({ arguments: "{not json" }), "t"],
    [done({ arguments: "[]" }), "t"],
    [done({ arguments: JSON.stringify({ cmd: "ls" }) }), "t"],
    [done({ arguments: JSON.stringify({ cmd: "ls", description: 7 }) }), "t"],
    [
      done({
        arguments: JSON.stringify({ cmd: "ls", description: " \u200b " }),
      }),
      "t",
    ],
    [done({ arguments: "x".repeat(200_001) }), "t"],
  ] as const;
  for (const [event, thread] of ignored)
    assert.equal(toolDescriptionFromResponse(event, thread), undefined);
});

test("descriptions are cleaned of controls, bidi and zero-width characters", () => {
  assert.equal(
    sanitizeDescription("  Run\u202e fdsa-mr \u2066the\u2069\ttests\n"),
    "Run fdsa-mr the tests",
  );
  assert.equal(sanitizeDescription("a\u0000b\u009fc\u200bd\ufeffe"), "abcde");
  assert.equal(sanitizeDescription("   "), undefined);
  assert.equal(sanitizeDescription(42), undefined);
  // Cut by code points, never inside a surrogate pair.
  const long = "😀".repeat(maxDescriptionLength + 20);
  const cut = sanitizeDescription(long)!;
  assert.equal(Array.from(cut).length, maxDescriptionLength);
  assert.ok(!/[\ud800-\udbff]$/.test(cut));
  assert.equal(sanitizeDescription("ok \ud800 fine"), "ok fine");
  assert.equal(sanitizeDescription("列出仓库文件"), "列出仓库文件");
});

test("the main process checks the signal again", () => {
  assert.deepEqual(
    parseToolDescriptionSignal({
      type: "toolDescription",
      threadId: "t",
      callId: "c",
      description: "Run the\u202e tests",
    }),
    { threadId: "t", callId: "c", description: "Run the tests" },
  );
  for (const bad of [
    null,
    { threadId: "t", callId: "c" },
    { threadId: "", callId: "c", description: "x" },
    { threadId: "t", callId: 3, description: "x" },
    { threadId: "t", callId: "c", description: "x".repeat(1000) },
    { threadId: "t", callId: "c", description: "\u200b" },
  ])
    assert.equal(parseToolDescriptionSignal(bad), undefined);
});
