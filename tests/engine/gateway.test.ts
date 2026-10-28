import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { Gateway } from "../../electron/engine/gateway";
import { readSSE } from "../../electron/engine/gateway-support";
import {
  endpoint,
  streamChatResponse,
  toChat,
} from "../../electron/engine/gateway-chat";
import type { Provider, UsageRecord } from "../../shared/types";
import type {
  ToolDescriptionEvent,
  WebSourcesEvent,
} from "../../shared/gateway-signals";

type Json = Record<string, any>;
const frame = (data: unknown, ending = "\n") =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}${ending}${ending}`;
function byteStream(text: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.length);
    },
  });
}
async function events(body: ReadableStream<Uint8Array>) {
  const result: Json[] = [];
  for await (const event of readSSE(body)) result.push(event);
  return result;
}
async function chatEvents(chunks: unknown[], tools: Json[] = []) {
  const result: Json[] = [];
  await streamChatResponse(
    new Response(
      byteStream(
        chunks.map((chunk) => frame(chunk)).join("") + frame("[DONE]"),
      ),
    ),
    (event) => result.push(event),
    toChat({ tools }).mapping,
    "mock-model",
  );
  return result;
}
async function mockServer(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.destroyed) res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
async function requestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function gateway(
  t: TestContext,
  baseUrl: string,
  protocol: Provider["protocol"] = "chat",
  apiKey = "local-mock-secret",
  recordUsage?: (record: UsageRecord) => void,
) {
  const bridge = new Gateway(
    () => ({
      provider: {
        id: "test",
        name: "Mock",
        model: "mock-model",
        models: [],
        baseUrl,
        protocol,
      },
      apiKey,
    }),
    recordUsage,
  );
  await bridge.start();
  t.after(() => bridge.close());
  const post = (body: Json, extra: RequestInit = {}) =>
    fetch(`${bridge.url}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify(body),
      ...extra,
    });
  return { bridge, post };
}

test("endpoint accepts configured API roots and full routes without duplicating paths", () => {
  assert.equal(
    endpoint("https://example.invalid/v1/", "responses"),
    "https://example.invalid/v1/responses",
  );
  assert.equal(
    endpoint(
      "https://example.invalid/custom/chat/completions?tenant=abc",
      "responses",
    ),
    "https://example.invalid/custom/responses?tenant=abc",
  );
  assert.equal(
    endpoint("https://example.invalid/v1/responses/", "chat/completions"),
    "https://example.invalid/v1/chat/completions",
  );
  assert.equal(
    endpoint(
      "https://example.invalid/v1/audio/transcriptions",
      "audio/transcriptions",
    ),
    "https://example.invalid/v1/audio/transcriptions",
  );
  assert.throws(() => endpoint("file:///tmp/models", "responses"), /http/);
  assert.throws(
    () => endpoint("https://user:secret@example.invalid/v1", "responses"),
    /without a password/,
  );
});

test("SSE survives every UTF-8 byte and CRLF being split, multiline data and comments", async () => {
  const wire =
    ': keepalive\r\nevent: message\r\ndata: {"text":\r\ndata: "你好 🌏", "n": 1}\r\n\r\n' +
    frame({ text: "second" }, "\r\n") +
    frame("[DONE]", "\r\n") +
    "data: invalid after done\n\n";
  assert.deepEqual(await events(byteStream(wire, 1)), [
    { text: "你好 🌏", n: 1 },
    { text: "second" },
  ]);
});

test("SSE accepts lone CR delimiters and flushes an unterminated last frame", async () => {
  assert.deepEqual(
    await events(byteStream(frame({ n: 1 }, "\r") + 'data: {"n":2}', 1)),
    [{ n: 1 }, { n: 2 }],
  );
});

test("SSE cancels upstream when DONE arrives or a consumer exits early", async () => {
  for (const done of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame({ n: 1 }) + (done ? frame("[DONE]") : ""),
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    if (done) assert.deepEqual(await events(body), [{ n: 1 }]);
    else
      for await (const value of readSSE(body)) {
        assert.equal(value.n, 1);
        break;
      }
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test("SSE reports malformed JSON and still releases its reader", async () => {
  const body = byteStream("data: {broken}\n\n");
  await assert.rejects(events(body), SyntaxError);
  assert.equal(body.locked, false);
});

test("toChat sends a tool output's images as images, after the tool messages", () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const { body } = toChat({
    input: [
      { role: "user", content: "Look at both" },
      {
        type: "function_call",
        call_id: "a",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "b",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "a",
        output: [{ type: "input_image", image_url: image, detail: "original" }],
      },
      {
        type: "function_call_output",
        call_id: "b",
        output: [
          { type: "input_text", text: "Screenshot" },
          { type: "input_image", image_url: image },
        ],
      },
      { role: "user", content: "Which is better?" },
    ],
  });
  assert.deepEqual(
    body.messages.map((m: Json) => m.role),
    ["user", "assistant", "tool", "tool", "user", "user"],
  );
  // The base64 is never text in a tool message.
  assert.equal(body.messages[2].content, "The image is attached below.");
  assert.equal(body.messages[3].content, "Screenshot");
  assert.deepEqual(body.messages[4].content, [
    { type: "text", text: "[Image output of tool call a]" },
    { type: "image_url", image_url: { url: image, detail: "high" } },
    { type: "text", text: "[Image output of tool call b]" },
    { type: "image_url", image_url: { url: image, detail: "auto" } },
  ]);
  assert.equal(body.messages[5].content, "Which is better?");
  // The last items: the images close the conversation.
  const last = toChat({
    input: [
      {
        type: "function_call",
        call_id: "c",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "c",
        output: [{ type: "input_image", image_url: image }],
      },
    ],
  }).body.messages;
  assert.equal(last.at(-1).role, "user");
  assert.equal(last.at(-1).content[1].type, "image_url");
});

test("toChat preserves image history, namespace/custom calls and explicit model/tool options", () => {
  const converted = toChat({
    model: "mock-model",
    instructions: "System instruction",
    tools: [
      {
        type: "namespace",
        name: "files",
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
            strict: true,
          },
        ],
      },
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: {
          type: "grammar",
          syntax: "lark",
          definition: 'start: "patch"',
        },
      },
    ],
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Project instruction" }],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,AA==",
            detail: "low",
          },
        ],
      },
      { type: "reasoning", summary: [] },
      {
        type: "function_call",
        call_id: "call_1",
        namespace: "files",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
      {
        type: "custom_tool_call",
        call_id: "call_2",
        name: "apply_patch",
        input: "*** Begin Patch\n你好\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "file contents",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: { ok: true },
      },
    ],
    tool_choice: { type: "custom", name: "apply_patch" },
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    temperature: 0,
    top_p: 0.9,
    max_output_tokens: 512,
    text: {
      format: {
        type: "json_schema",
        name: "result",
        schema: { type: "object" },
        strict: true,
      },
    },
  });
  const { body, mapping } = converted;
  assert.deepEqual(
    body.messages.map((m: Json) => m.role),
    ["system", "system", "user", "assistant", "tool", "tool"],
  );
  assert.deepEqual(body.messages[2].content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AA==", detail: "low" },
  });
  assert.equal(body.messages[3].tool_calls[0].function.name, "files__read");
  assert.equal(
    JSON.parse(body.messages[3].tool_calls[1].function.arguments).input,
    "*** Begin Patch\n你好\n*** End Patch",
  );
  assert.deepEqual(body.messages[5], {
    role: "tool",
    tool_call_id: "call_2",
    content: '{"ok":true}',
  });
  assert.deepEqual(mapping.get("files__read"), {
    original: "read",
    namespace: "files",
    custom: false,
  });
  assert.equal(body.tools[0].function.strict, true);
  assert.match(body.tools[1].function.description, /start: "patch"/);
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "apply_patch" },
  });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(
    toChat({ reasoning: { effort: "xhigh" } }).body.reasoning_effort,
    "xhigh",
  );
  assert.equal(
    toChat({ reasoning: { effort: "max" } }).body.reasoning_effort,
    "max",
  );
  assert.equal(body.temperature, 0);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_completion_tokens, 512);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "result", schema: { type: "object" }, strict: true },
  });
  for (const tool_choice of ["none", "auto", "required"])
    assert.equal(toChat({ tool_choice }).body.tool_choice, tool_choice);
});

test("tool aliases stay valid, distinct and reversible for collisions and long namespace names", () => {
  const namespace = "long_namespace_".repeat(8);
  const { body, mapping } = toChat({
    tools: [
      { type: "function", name: "files__read" },
      {
        type: "namespace",
        name: "files",
        tools: [{ type: "function", name: "read" }],
      },
      {
        type: "namespace",
        name: namespace,
        tools: [{ type: "custom", name: "修改" }],
      },
    ],
    input: [
      {
        type: "function_call",
        namespace: "files",
        name: "read",
        call_id: "call_1",
        arguments: "{}",
      },
      {
        type: "custom_tool_call",
        namespace,
        name: "修改",
        call_id: "call_2",
        input: "raw",
      },
    ],
  });
  const names = body.tools.map((tool: Json) => tool.function.name);
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(body.messages[0].tool_calls[0].function.name, names[1]);
  assert.equal(body.messages[0].tool_calls[1].function.name, names[2]);
  assert.deepEqual(mapping.get(names[2]), {
    original: "修改",
    namespace,
    custom: true,
  });
});

test("toChat fails explicitly for stateful requests and incompatible tools/input", () => {
  assert.throws(
    () => toChat({ previous_response_id: "resp_1" }),
    /previous_response_id/,
  );
  assert.throws(
    () => toChat({ tools: [{ type: "web_search" }] }),
    /built-in tool/,
  );
  assert.throws(
    () => toChat({ tools: [{ type: "tool_search" }] }),
    /built-in tool/,
  );
  assert.throws(
    () => toChat({ input: [{ type: "computer_call" }] }),
    /computer_call/,
  );
  assert.throws(
    () =>
      toChat({ input: [{ role: "user", content: [{ type: "input_file" }] }] }),
    /input_file/,
  );
  assert.throws(
    () =>
      toChat({
        tools: [
          { type: "function", name: "a" },
          { type: "custom", name: "a" },
        ],
      }),
    /Duplicate tool name/,
  );
  assert.throws(
    () => toChat({ tool_choice: { type: "function", name: "unknown" } }),
    /unknown tool/,
  );
});

test("a tool the request does not offer reaches Codex as a function call instead of cutting the reply", async () => {
  const result = await chatEvents([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_x",
                function: {
                  name: "write_imagegen_prompt",
                  arguments: '{"a":1}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]);
  const done = result.find(
    (event) =>
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call",
  );
  assert.equal(done?.item.name, "write_imagegen_prompt");
  assert.equal(done?.item.call_id, "call_x");
  assert.equal(done?.item.arguments, '{"a":1}');
  assert.equal(result.at(-1)?.type, "response.completed");
});

test("Chat text becomes ordered Responses events with final usage including trailing usage chunk", async () => {
  const result = await chatEvents([
    {
      choices: [
        { delta: { role: "assistant", content: "你好 " }, finish_reason: null },
      ],
    },
    { choices: [{ delta: { content: "🌏" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    },
  ]);
  assert.deepEqual(
    result.map((e) => e.sequence_number),
    result.map((_, i) => i),
  );
  const completed = result.at(-1)!.response;
  assert.equal(result.at(-1)!.type, "response.completed");
  assert.equal(completed.output[0].content[0].text, "你好 🌏");
  assert.equal(completed.id, result[0].response.id);
  assert.deepEqual(
    result[0].response.output,
    [],
    "created response must not mutate into completed response",
  );
  assert.deepEqual(completed.usage, {
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  });
});

test("interleaved fragmented Chat tools restore function namespaces and raw custom input", async () => {
  const patch = "*** Begin Patch\n你好\n*** End Patch";
  const args = JSON.stringify({ input: patch });
  const result = await chatEvents(
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_patch",
                  function: { name: "apply_", arguments: args.slice(0, 8) },
                },
                {
                  index: 0,
                  id: "call_read",
                  function: { name: "files__", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "read", arguments: '"a.ts"}' } },
                {
                  index: 1,
                  function: { name: "patch", arguments: args.slice(8) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ],
    [
      {
        type: "namespace",
        name: "files",
        tools: [{ type: "function", name: "read" }],
      },
      { type: "custom", name: "apply_patch" },
    ],
  );
  const output = result.at(-1)!.response.output;
  assert.equal(output[0].type, "function_call");
  assert.equal(output[0].namespace, "files");
  assert.equal(output[0].name, "read");
  assert.equal(output[0].call_id, "call_read");
  assert.equal(output[0].arguments, '{"path":"a.ts"}');
  assert.equal(output[1].type, "custom_tool_call");
  assert.equal(output[1].input, patch);
  assert.equal(output[1].call_id, "call_patch");
  assert.equal(
    result.find((e) => e.type === "response.custom_tool_call_input.delta")!
      .delta,
    patch,
  );
  assert.deepEqual(
    result
      .filter((e) => e.type === "response.output_item.done")
      .map((e) => e.output_index),
    [0, 1],
  );
});

test("Chat truncation, filters, refusals and invalid tools never emit completed responses", async (t) => {
  const cases: [string, unknown[], Json[], RegExp][] = [
    [
      "disconnect",
      [{ choices: [{ delta: { content: "partial" } }] }],
      [],
      /closed before the response finished/,
    ],
    [
      "length",
      [
        {
          choices: [{ delta: { content: "partial" }, finish_reason: "length" }],
        },
      ],
      [],
      /maximum output length/,
    ],
    [
      "tool-use limit",
      [
        {
          choices: [
            { delta: { content: "partial" }, finish_reason: "tool_use_limit" },
          ],
        },
      ],
      [],
      /tool-use limit/,
    ],
    [
      "filter",
      [{ choices: [{ delta: {}, finish_reason: "content_filter" }] }],
      [],
      /blocked/,
    ],
    [
      "refusal",
      [
        {
          choices: [
            { delta: { refusal: "Cannot comply" }, finish_reason: "stop" },
          ],
        },
      ],
      [],
      /Cannot comply/,
    ],
    [
      "provider error",
      [{ error: { message: "upstream failure" } }],
      [],
      /upstream failure/,
    ],
    [
      "custom missing input",
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "patch", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      [{ type: "custom", name: "patch" }],
      /input/,
    ],
    [
      "malformed arguments",
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "read", arguments: "{" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      [{ type: "function", name: "read" }],
      /JSON|property|position|Expected/,
    ],
    [
      "non-object arguments",
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "read", arguments: "[]" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      [{ type: "function", name: "read" }],
      /JSON object/,
    ],
  ];
  for (const [name, chunks, tools, pattern] of cases)
    await t.test(name, async () => {
      const result: Json[] = [];
      await assert.rejects(
        streamChatResponse(
          new Response(
            byteStream(
              chunks.map((chunk) => frame(chunk)).join("") + frame("[DONE]"),
            ),
          ),
          (event) => result.push(event),
          toChat({ tools }).mapping,
          "mock",
        ),
        pattern,
      );
      assert.equal(
        result.some((e) => e.type === "response.completed"),
        false,
      );
    });
});

test("gateway requires its private bearer token, rejects browser origins and unsupported routes", async (t) => {
  let hits = 0;
  const baseUrl = await mockServer(t, (_req, res) => {
    hits++;
    res.end();
  });
  const { bridge, post } = await gateway(t, baseUrl);
  assert.equal(await bridge.start(), bridge.url);
  const invalidHeaders: Record<string, string>[] = [
    {},
    { authorization: "Bearer wrong" },
    {
      authorization: `Bearer ${bridge.token}`,
      origin: "https://example.invalid",
    },
  ];
  for (const headers of invalidHeaders) {
    const response = await post({ input: "hello" }, { headers });
    assert.equal(response.status, 401);
    await response.text();
  }
  const response = await fetch(`${bridge.url}/models`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  assert.equal(response.status, 404);
  await response.text();
  assert.equal(hits, 0);
});

test("gateway forwards translated Chat requests and injects provider credentials only upstream", async (t) => {
  let received: Json = {};
  const baseUrl = await mockServer(t, async (req, res) => {
    received = {
      path: req.url,
      authorization: req.headers.authorization,
      body: await requestBody(req),
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({
        choices: [{ delta: { content: "桥接成功" }, finish_reason: "stop" }],
      }) + frame("[DONE]"),
    );
  });
  const { bridge, post } = await gateway(t, baseUrl);
  const response = await post({
    model: "test-model",
    input: "Hello",
    stream: true,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const wire = await response.text();
  assert.equal(received.path, "/v1/chat/completions");
  assert.equal(received.authorization, "Bearer local-mock-secret");
  assert.deepEqual(received.body.messages, [
    { role: "user", content: "Hello" },
  ]);
  assert.equal(received.body.model, "test-model");
  assert.equal(received.body.stream, true);
  assert.equal(wire.includes("local-mock-secret"), false);
  assert.equal(wire.includes(bridge.token), false);
  const result = await events(byteStream(wire));
  assert.equal(result.at(-1)!.response.output[0].content[0].text, "桥接成功");
});

test("Responses mode preserves the complete upstream request and raw SSE bytes", async (t) => {
  let received: Json = {};
  const wire =
    'event: vendor.extension\r\ndata: {"hello":"世界"}\r\n\r\n' +
    frame({
      type: "response.completed",
      response: { id: "resp_mock", status: "completed" },
    });
  const baseUrl = await mockServer(t, async (req, res) => {
    received = {
      path: req.url,
      authorization: req.headers.authorization,
      body: await requestBody(req),
    };
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(wire);
  });
  const { post } = await gateway(
    t,
    `${baseUrl}/responses?tenant=local`,
    "responses",
  );
  const request = {
    model: "vendor-model",
    stream: true,
    input: "Hello",
    tools: [{ type: "tool_search", execution: "client" }],
    previous_response_id: "resp_before",
    vendor_setting: { keep: true },
  };
  const response = await post(request);
  assert.equal(await response.text(), wire);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(received.path, "/v1/responses?tenant=local");
  assert.equal(received.authorization, "Bearer local-mock-secret");
  assert.deepEqual(received.body, request);
});

test("gateway records only usage metadata for Chat and Responses streams", async (t) => {
  const recorded: UsageRecord[] = [];
  const chatUrl = await mockServer(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      }) +
        frame({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }) +
        frame("[DONE]"),
    );
  });
  const chat = await gateway(
    t,
    chatUrl,
    "chat",
    "server-only-fixture",
    (record) => recorded.push(record),
  );
  await (
    await chat.post({
      model: "chat-model",
      input: "synthetic prompt",
      stream: true,
    })
  ).text();
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    [
      recorded[0].inputTokens,
      recorded[0].outputTokens,
      recorded[0].cachedTokens,
      recorded[0].reasoningTokens,
    ],
    [12, 7, 3, 2],
  );
  assert.equal(recorded[0].protocol, "chat");
  assert.equal(recorded[0].usageKnown, true);
  assert.equal(JSON.stringify(recorded).includes("synthetic prompt"), false);
  assert.equal(JSON.stringify(recorded).includes("server-only-fixture"), false);
  const responseUrl = await mockServer(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 21,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 8 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      }),
    );
  });
  const responses = await gateway(
    t,
    responseUrl,
    "responses",
    "server-only-fixture",
    (record) => recorded.push(record),
  );
  await (
    await responses.post({
      model: "responses-model",
      input: "synthetic prompt",
      stream: true,
    })
  ).text();
  assert.equal(recorded.length, 2);
  assert.deepEqual(
    [
      recorded[1].inputTokens,
      recorded[1].outputTokens,
      recorded[1].cachedTokens,
      recorded[1].reasoningTokens,
    ],
    [21, 5, 8, 1],
  );
  assert.equal(recorded[1].protocol, "responses");
  assert.equal(recorded[1].statusCode, 200);
});

test("Responses mode preserves JSON responses and allows providers without an API key", async (t) => {
  const payload = { id: "resp_json", status: "completed", output: [] };
  const baseUrl = await mockServer(t, async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal((await requestBody(req)).stream, false);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  const { post } = await gateway(t, baseUrl, "responses", "");
  const response = await post({ model: "mock", input: "hello", stream: false });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), payload);
});

test("gateway returns client errors for malformed/incompatible requests without contacting upstream", async (t) => {
  let hits = 0;
  const baseUrl = await mockServer(t, (_req, res) => {
    hits++;
    res.end();
  });
  const { post } = await gateway(t, baseUrl);
  for (const request of [
    { stream: false, input: "hello" },
    { tools: [{ type: "web_search" }] },
    { previous_response_id: "resp_1" },
  ]) {
    const response = await post(request);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.message);
  }
  const response = await post({}, { body: "{broken" });
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(hits, 0);
});

test("managed model allowlist rejects an unassigned model before contacting upstream", async (t) => {
  let hits = 0;
  const baseUrl = await mockServer(t, (_req, res) => {
    hits++;
    res.end();
  });
  const provider: Provider = {
    id: "managed",
    name: "Claudex",
    model: "assigned-model",
    models: ["assigned-model"],
    baseUrl,
    protocol: "responses",
  };
  const bridge = new Gateway(() => ({
    provider,
    apiKey: "server-only-fixture",
  }));
  await bridge.start();
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.url}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "unassigned-model",
      input: "Hello",
      stream: true,
    }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error.message, /can't use this model/);
  assert.equal(hits, 0);
});

test("gateway preserves upstream HTTP errors and redacts keys before truncating error text", async (t) => {
  const key =
    "local-secret-key-that-straddles-the-error-text-truncation-boundary";
  const baseUrl = await mockServer(t, (_req, res) => {
    res.writeHead(429);
    res.end("x".repeat(3980) + key + " retry later");
  });
  const { post } = await gateway(t, baseUrl, "chat", key);
  const response = await post({ model: "mock", input: "hello" });
  assert.equal(response.status, 429);
  const text = await response.text();
  assert.equal(text.includes("local-secret-key"), false);
  assert.match(text, /\[redacted\]/);
});

test("gateway converts in-stream truncation into a terminal failure with the same response ID", async (t) => {
  const baseUrl = await mockServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({
        choices: [{ delta: { content: "partial" }, finish_reason: "length" }],
      }) + frame("[DONE]"),
    );
  });
  const { post } = await gateway(t, baseUrl);
  const response = await post({ model: "mock", input: "hello" });
  const result = await events(response.body!);
  assert.equal(result.at(-1)!.type, "response.failed");
  assert.equal(result.at(-1)!.response.id, result[0].response.id);
  assert.equal(result.at(-1)!.response.status, "failed");
  assert.match(result.at(-1)!.response.error.message, /maximum output length/);
  assert.equal(
    result.some((e) => e.type === "response.completed"),
    false,
  );
  assert.deepEqual(
    result.map((e) => e.sequence_number),
    result.map((_, i) => i),
  );
});

test(
  "cancelling the downstream request aborts the active upstream stream",
  { timeout: 5000 },
  async (t) => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const baseUrl = await mockServer(t, (_req, res) => {
      res.on("close", resolveClosed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame({ choices: [{ delta: { content: "working" } }] }));
    });
    const { post } = await gateway(t, baseUrl);
    const controller = new AbortController();
    const response = await post(
      { model: "mock", input: "hello" },
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await closed;
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  },
);

test(
  "abortThread closes only matching requests, using metadata and prompt_cache_key fallback",
  { timeout: 5000 },
  async (t) => {
    for (const protocol of ["chat", "responses"] as const)
      await t.test(protocol, async (t) => {
        const closed = new Set<string>();
        const closeResolvers = new Map<string, () => void>();
        const closePromises = new Map(
          ["a", "b", "fallback"].map((id) => [
            id,
            new Promise<void>((resolve) => closeResolvers.set(id, resolve)),
          ]),
        );
        const baseUrl = await mockServer(t, async (req, res) => {
          const body = await requestBody(req);
          const id = body.model;
          res.on("close", () => {
            closed.add(id);
            closeResolvers.get(id)!();
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            frame(
              protocol === "chat"
                ? { choices: [{ delta: { content: "working" } }] }
                : {
                    type: "response.created",
                    response: { id: `resp_${id}`, status: "in_progress" },
                  },
            ),
          );
        });
        const { bridge, post } = await gateway(t, baseUrl, protocol);
        const cleanup = new AbortController();
        const responses = await Promise.all([
          post(
            {
              model: "a",
              input: "hello",
              client_metadata: { thread_id: "thread-a" },
              prompt_cache_key: "unrelated",
            },
            { signal: cleanup.signal },
          ),
          post(
            {
              model: "b",
              input: "hello",
              client_metadata: { thread_id: "thread-b" },
            },
            { signal: cleanup.signal },
          ),
          post(
            { model: "fallback", input: "hello", prompt_cache_key: "thread-a" },
            { signal: cleanup.signal },
          ),
        ]);
        const readers = responses.map((response) => response.body!.getReader());
        await Promise.all(readers.map((reader) => reader.read()));
        bridge.abortThread("thread-a");
        await Promise.all([
          closePromises.get("a"),
          closePromises.get("fallback"),
        ]);
        assert.equal(closed.has("b"), false);
        bridge.abortThread("missing-thread");
        assert.equal(closed.has("b"), false);
        cleanup.abort();
        await closePromises.get("b");
        for (const reader of readers) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
  },
);

// S1 (R7-A, R45b): request rewrites and stream observers.
async function observedGateway(
  t: TestContext,
  baseUrl: string,
  protocol: Provider["protocol"],
) {
  const descriptions: ToolDescriptionEvent[] = [];
  const sources: WebSourcesEvent[] = [];
  const bridge = new Gateway(
    () => ({
      provider: {
        id: "test",
        name: "Mock",
        model: "grok-4",
        models: [],
        baseUrl,
        protocol,
      },
      apiKey: "local-mock-secret",
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onToolDescription: (event) => descriptions.push(event),
      onWebSources: (event) => sources.push(event),
    },
  );
  await bridge.start();
  t.after(() => bridge.close());
  const post = (body: Json) =>
    fetch(`${bridge.url}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify(body),
    });
  return { bridge, post, descriptions, sources };
}
const shellTool = {
  type: "function",
  name: "exec_command",
  strict: false,
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  },
};

test("Responses requests get shell descriptions, search sources and grok X search; the stream is observed unchanged", async (t) => {
  const received: Json[] = [];
  const call = {
    id: "fc_1",
    type: "function_call",
    name: "exec_command",
    call_id: "call_1",
    arguments: JSON.stringify({ cmd: "ls", description: "List files" }),
  };
  const wire =
    frame({ type: "response.output_item.done", item: call }) +
    frame({
      type: "response.output_item.done",
      item: {
        id: "ws_1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "q",
          sources: [{ type: "url", url: "https://a.example/" }],
        },
      },
    }) +
    frame({
      type: "response.completed",
      response: { id: "resp", status: "completed" },
    });
  const baseUrl = await mockServer(t, async (req, res) => {
    received.push(await requestBody(req));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(wire);
  });
  const { bridge, post, descriptions, sources } = await observedGateway(
    t,
    baseUrl,
    "responses",
  );
  const request = {
    model: "grok-4",
    client_metadata: { thread_id: "thread-1" },
    input: "hi",
    tools: [shellTool, { type: "web_search", external_web_access: true }],
  };
  assert.equal(await (await post(request)).text(), wire);
  const sent = received[0];
  assert.deepEqual(sent.tools[0].parameters.required, ["cmd", "description"]);
  assert.deepEqual(sent.include, ["web_search_call.action.sources"]);
  assert.equal(
    sent.tools.some((tool: Json) => tool.type === "x_search"),
    false,
    "X search only for models the main process lists",
  );
  assert.deepEqual(descriptions, [
    { threadId: "thread-1", callId: "call_1", description: "List files" },
  ]);
  assert.equal(sources[0].kind, "search");
  assert.equal(sources[0].threadId, "thread-1");

  bridge.setRequestOptions({ describeTools: false, xSearchModels: ["grok-4"] });
  await (await post(request)).text();
  const second = received[1];
  assert.deepEqual(second.tools[0], shellTool, "the description switch is off");
  assert.deepEqual(second.tools.at(-1), { type: "x_search" });
  assert.deepEqual(second.include, [
    "web_search_call.action.sources",
    "x_search_call.action.sources",
  ]);
  // Without web search nothing about search is added.
  await (await post({ ...request, tools: [shellTool] })).text();
  assert.equal(received[2].include, undefined);
  assert.deepEqual(received[2].tools, [shellTool]);
});

test("the Chat bridge sends the description parameter and reports descriptions", async (t) => {
  let received: Json = {};
  const baseUrl = await mockServer(t, async (req, res) => {
    received = await requestBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_9",
                  function: {
                    name: "exec_command",
                    arguments: JSON.stringify({
                      cmd: "npm test",
                      description: "Run the unit tests",
                    }),
                  },
                },
              ],
            },
          },
        ],
      }) +
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
        frame("[DONE]"),
    );
  });
  const { post, descriptions, sources } = await observedGateway(
    t,
    baseUrl,
    "chat",
  );
  await (
    await post({
      model: "grok-4",
      prompt_cache_key: "thread-9",
      input: "hi",
      tools: [shellTool],
    })
  ).text();
  assert.deepEqual(received.tools[0].function.parameters.required, [
    "cmd",
    "description",
  ]);
  assert.deepEqual(descriptions, [
    {
      threadId: "thread-9",
      callId: "call_9",
      description: "Run the unit tests",
    },
  ]);
  assert.deepEqual(sources, []);
});

test("Auto mode's reviewer reviews with the account's model, not Codex's review model", async (t) => {
  let upstreamModel: string | undefined;
  const baseUrl = await mockServer(t, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      upstreamModel = JSON.parse(body).model;
      res.writeHead(500);
      res.end();
    });
  });
  const provider: Provider = {
    id: "managed",
    name: "Claudex",
    model: "assigned-model",
    models: ["assigned-model"],
    baseUrl,
    protocol: "responses",
  };
  const bridge = new Gateway(() => ({
    provider,
    apiKey: "server-only-fixture",
  }));
  await bridge.start();
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.url}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "codex-auto-review",
      input: "Review this action",
      stream: true,
    }),
  });
  assert.notEqual(response.status, 403);
  await response.text();
  assert.equal(upstreamModel, "assigned-model");
});
