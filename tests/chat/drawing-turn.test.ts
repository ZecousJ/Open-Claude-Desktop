import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Gateway } from "../../electron/engine/gateway";
import {
  activeGroups,
  apiGroupsFor,
  catalogInGroup,
  drawsOnly,
  type ServiceGroup,
} from "../../electron/account/api-groups";
import {
  drawingPrompt,
  drawingRequest,
  withoutEmptyImageCalls,
} from "../../server/drawing-turn";
import {
  codeModelChoices,
  modelVendor,
} from "../../src/composer/model/code-model-choices";
import type { GeneratedImageEvent } from "../../server/image-observer";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("the drawing prompt is the person's latest message, its pictures make it an edit", () => {
  const request = {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md\nrules" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "a red fox" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>x</environment_context>",
          },
          { type: "input_text", text: "make it blue" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ],
  };
  const { prompt, images } = drawingPrompt(request);
  assert.equal(prompt, "make it blue");
  assert.deepEqual(images, ["data:image/png;base64,AAAA"]);
  assert.deepEqual(drawingRequest("gpt-image-2.5", prompt, images), {
    route: "images/edits",
    body: {
      model: "gpt-image-2.5",
      prompt: "make it blue",
      n: 1,
      images: [{ image_url: "data:image/png;base64,AAAA" }],
    },
  });
  assert.equal(
    drawingRequest("gpt-image-2.5", "a fox", []).route,
    "images/generations",
  );
});

test("earlier pictures without their bytes are not sent to the model service", () => {
  const request = {
    model: "gpt-6-sol",
    input: [
      {
        type: "image_generation_call",
        id: "ig_1",
        status: "completed",
        result: "",
      },
      {
        type: "image_generation_call",
        id: "ig_2",
        status: "completed",
        result: png,
      },
      { type: "message", role: "user", content: "hi" },
    ],
  };
  assert.deepEqual(
    withoutEmptyImageCalls(request).input.map(
      (item: { id?: string; type: string }) => item.id ?? item.type,
    ),
    ["ig_2", "message"],
  );
  const untouched = {
    model: "x",
    input: [{ type: "message", role: "user", content: "hi" }],
  };
  assert.equal(withoutEmptyImageCalls(untouched), untouched);
});

const groups: ServiceGroup[] = [
  {
    id: 2,
    name: "codex",
    primary: true,
    protocol: "responses",
    platform: "openai",
    models: ["gpt-6-sol"],
  },
  {
    id: 3,
    name: "grok",
    primary: false,
    protocol: "chat",
    platform: "grok",
    models: ["grok-4.7"],
  },
  {
    id: 5,
    name: "生图",
    primary: false,
    protocol: "responses",
    platform: "openai",
    models: ["gpt-image-2", "gpt-image-2.5"],
    drawing: true,
  },
];

test("the drawing group is never offered or chosen; its models stay in the menus", () => {
  assert.equal(drawsOnly(["gpt-image-2", "gpt-image-2.5"]), true);
  assert.equal(drawsOnly(["gpt-image-2", "gpt-6-sol"]), false);
  assert.equal(drawsOnly([]), false);
  // Even chosen before, the drawing group does not take OpenAI's place.
  assert.equal(activeGroups(groups, { openai: 5 }).get("openai")?.id, 2);
  const api = apiGroupsFor(null, groups, {});
  assert.deepEqual(
    api.groups.map((g) => g.id),
    [2, 3],
  );
  assert.ok(api.providers.every((p) => p.groups.every((g) => g.id !== 5)));
  const item = (id: string, groupId: number) => ({
    id,
    groupId,
    displayName: id,
    description: "",
    badges: [],
    sort: 0,
    hidden: false,
    isDefault: false,
    usageHint: "",
  });
  const catalog = catalogInGroup(
    {
      defaultModel: "gpt-6-sol",
      items: [
        item("gpt-6-sol", 2),
        item("grok-4.7", 3),
        item("gpt-image-2.5", 5),
      ],
    },
    groups,
    {},
  );
  assert.deepEqual(
    catalog?.items.map((i) => i.id),
    ["gpt-6-sol", "grok-4.7", "gpt-image-2.5"],
  );
});

test("picture models are not in the model menus; DeepSeek has its own place", () => {
  const provider = {
    id: "sub2api",
    name: "Claudex",
    model: "gpt-6-sol",
    models: ["gpt-6-sol", "gpt-image-2.5", "deepseek-v4-pro"],
  } as never;
  const { quick, more } = codeModelChoices([provider], "sub2api", "gpt-6-sol");
  assert.deepEqual(
    [...quick, ...more].map((c) => c.name),
    ["gpt-6-sol", "deepseek-v4-pro"],
  );
  assert.deepEqual(modelVendor("deepseek-v4-pro"), {
    id: "deepseek",
    name: "DeepSeek",
  });
});

test("a picture model's turn is answered with a picture from the drawing group", async (t) => {
  const seen: { url?: string; auth?: string; body?: Record<string, unknown> } =
    {};
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    Object.assign(seen, {
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        data: [{ b64_json: png }],
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const images: GeneratedImageEvent[] = [];
  const provider = {
    id: "sub2api",
    name: "Claudex",
    model: "gpt-6-sol",
    models: ["gpt-6-sol", "gpt-image-2.5"],
    baseUrl: base,
    protocol: "responses",
    routes: [
      {
        groupId: 2,
        keyId: "sub2api",
        primary: true,
        protocol: "responses",
        models: ["gpt-6-sol"],
      },
      {
        groupId: 5,
        keyId: "sub2api:g5",
        primary: false,
        protocol: "responses",
        models: ["gpt-image-2.5"],
      },
    ],
  };
  const gateway = new Gateway(
    () => ({
      provider: provider as never,
      apiKey: "codex-key",
      keyFor: (keyId) => (keyId === "sub2api:g5" ? "drawing-key" : ""),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    { onGeneratedImage: (event) => images.push(event) },
  );
  await gateway.start();
  t.after(() => gateway.close());

  const answer = await fetch(`${gateway.url}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gateway.token}`,
    },
    body: JSON.stringify({
      model: "gpt-image-2.5",
      stream: true,
      client_metadata: { thread_id: "thread-1" },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a red fox" }],
        },
      ],
    }),
  });
  assert.equal(answer.status, 200);
  const text = await answer.text();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(
    events.map((e) => e.type),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  const done = events[1].item;
  assert.equal(done.type, "image_generation_call");
  assert.equal(done.status, "completed");
  assert.equal(done.result, "");
  assert.equal(seen.url, "/v1/images/generations");
  assert.equal(seen.auth, "Bearer drawing-key");
  assert.deepEqual(seen.body, {
    model: "gpt-image-2.5",
    prompt: "a red fox",
    n: 1,
  });
  assert.equal(images.length, 1);
  assert.equal(images[0]!.base64, png);
  assert.equal(images[0]!.threadId, "thread-1");
  assert.equal(images[0]!.callId, done.id);

  // The skill's image requests also go out with the drawing group's key,
  // and their pictures reach the observers (the turn's Image card).
  await fetch(`${gateway.url}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gateway.token}`,
    },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "a fox" }),
  });
  assert.equal(seen.auth, "Bearer drawing-key");
  assert.equal(images.length, 2);
  assert.equal(images[1]!.base64, png);
  assert.equal(images[1]!.threadId, undefined, "the running turn takes it");
});

test("a picture from the provider child is checked before it is saved", async () => {
  const { parseGeneratedImageSignal } =
    await import("../../server/image-observer");
  assert.deepEqual(
    parseGeneratedImageSignal({
      threadId: "t",
      callId: "ig_1",
      base64: png,
      format: "png",
    }),
    { threadId: "t", callId: "ig_1", base64: png, format: "png" },
  );
  assert.equal(
    parseGeneratedImageSignal({ callId: "ig_1", base64: png, format: "gif" }),
    undefined,
  );
  assert.equal(
    parseGeneratedImageSignal({ callId: "", base64: png, format: "png" }),
    undefined,
  );
  assert.equal(parseGeneratedImageSignal(null), undefined);
});

test("the image model chosen on the API page makes every picture", async () => {
  const { withImageModel } =
    await import("../../electron/engine/gateway-support");
  const { imagesFor } = await import("../../electron/account/api-groups");
  const { parseRequestOptions } = await import("../../shared/gateway-signals");

  const json = await withImageModel(
    Buffer.from(JSON.stringify({ model: "gpt-image-2", prompt: "a fox" })),
    "application/json",
    "gpt-image-2.5",
  );
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(json.body as Uint8Array)),
    {
      model: "gpt-image-2.5",
      prompt: "a fox",
    },
  );
  const form = new FormData();
  form.set("model", "gpt-image-2");
  form.set("prompt", "make it blue");
  form.set(
    "image",
    new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    "a.png",
  );
  const encoded = new Response(form);
  const multipart = await withImageModel(
    Buffer.from(await encoded.arrayBuffer()),
    encoded.headers.get("content-type")!,
    "gpt-image-2.5",
  );
  assert.ok(multipart.body instanceof FormData);
  assert.equal((multipart.body as FormData).get("model"), "gpt-image-2.5");
  assert.equal(((multipart.body as FormData).get("image") as File).size, 3);
  const untouched = await withImageModel(
    Buffer.from("x"),
    "application/json",
    undefined,
  );
  assert.equal(new TextDecoder().decode(untouched.body as Uint8Array), "x");

  const item = (id: string, groupId: number, sort: number) => ({
    id,
    groupId,
    displayName: id.replace("gpt-image-", "GPT Image "),
    description: "",
    badges: [],
    sort,
    hidden: false,
    isDefault: false,
    usageHint: "",
  });
  const catalog = {
    defaultModel: "gpt-6-sol",
    items: [
      item("gpt-image-2.5", 5, 0),
      item("gpt-image-2", 5, 1),
      item("gpt-6-sol", 2, 0),
    ],
  };
  assert.deepEqual(imagesFor(catalog, groups, undefined), {
    groupId: 5,
    models: [
      { id: "gpt-image-2.5", name: "GPT Image 2.5" },
      { id: "gpt-image-2", name: "GPT Image 2" },
    ],
    selected: "gpt-image-2.5",
  });
  assert.equal(
    imagesFor(catalog, groups, "gpt-image-2")?.selected,
    "gpt-image-2",
  );
  assert.equal(
    imagesFor(catalog, groups, "gpt-image-9")?.selected,
    "gpt-image-2.5",
  );
  assert.equal(
    imagesFor(
      catalog,
      groups.filter((g) => !g.drawing),
      undefined,
    ),
    undefined,
  );

  assert.equal(
    parseRequestOptions({
      describeTools: true,
      xSearchModels: [],
      imageModel: "gpt-image-2.5",
    })?.imageModel,
    "gpt-image-2.5",
  );
  assert.equal(
    parseRequestOptions({
      describeTools: true,
      xSearchModels: [],
      imageModel: "bad model\n",
    })?.imageModel,
    undefined,
  );
});
