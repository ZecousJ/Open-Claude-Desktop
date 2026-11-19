import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { build } from "esbuild";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import {
  builtinImagegenSkill,
  installApiImageSkill,
  writeImageProviderFiles,
} from "../../electron/skills/api-image";
import { apiImageFiles } from "../../electron/skills/api-image-files";
import { mergeGroupModels } from "../../shared/provider-routes";
import type { Provider } from "../../shared/types";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function imageBridge(t: TestContext, backend?: Provider["backend"]) {
  const seen: { url?: string; auth?: string; type?: string; body: Buffer }[] =
    [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      auth: req.headers.authorization,
      type: req.headers["content-type"],
      body: Buffer.concat(chunks),
    });
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const merged = mergeGroupModels(
    [
      {
        groupId: 4,
        groupName: "Chat",
        keyId: "primary",
        primary: true,
        protocol: "responses",
        models: ["claude-opus-5-5", "gpt-image-1"],
      },
      {
        groupId: 2,
        groupName: "Mixed",
        keyId: "mixed",
        primary: false,
        protocol: "responses",
        models: ["gpt-6.1-sol", "gpt-image-2"],
      },
      {
        groupId: 6,
        groupName: "Images",
        keyId: "drawing",
        primary: false,
        protocol: "responses",
        models: ["gpt-image-1.5"],
      },
      {
        groupId: 7,
        groupName: "Advanced GPT",
        keyId: "gpt",
        primary: false,
        protocol: "responses",
        models: ["gpt-6.1-sol"],
      },
    ],
    null,
    [4, 7],
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-image-gateway-"));
  const script = path.join(root, "provider-service.cjs");
  const provider: Provider = {
    id: "test",
    name: "Test service",
    model: "claude-opus-5-5",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    protocol: "responses",
    backend,
    ...(backend ? merged : { models: ["claude-opus-5-5", "gpt-image-2"] }),
  };
  const bridge = new ProviderServiceClient(
    script,
    root,
    provider,
    "primary-key",
  );
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
    logLevel: "silent",
  });
  if (backend)
    bridge.sessionGroupKeys = {
      drawing: "drawing-key",
      mixed: "mixed-key",
      gpt: "gpt-key",
    };
  await bridge.start();
  const oldOptions = {
    describeTools: false,
    xSearchModels: [],
    imageModel: "gpt-image-1",
  };
  await bridge.setRequestOptions(oldOptions);
  const send = (
    route: string,
    body: BodyInit,
    contentType = "application/json",
  ) =>
    fetch(`${bridge.url}/${route}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Bearer ${bridge.token}`,
      },
      body,
    });
  const latest = () => {
    const request = seen.at(-1);
    assert.ok(request);
    return request;
  };
  return { bridge, provider, seen, send, latest };
}

test("managed generation and edits use the drawing group and preserve the request bytes", async (t) => {
  const { bridge, provider, seen, send, latest } = await imageBridge(
    t,
    "sub2api",
  );
  const generation =
    '{"model":"gpt-image-2","prompt":"a fox","quality":"high"}';
  const answer = await send("images/generations", generation);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { data: [{ b64_json: png }] });
  assert.deepEqual(latest(), {
    url: "/v1/claudex/images/generations",
    auth: "Bearer drawing-key",
    type: "application/json",
    body: Buffer.from(generation),
  });

  const form = new FormData();
  form.set("model", "gpt-image-2");
  form.set("prompt", "make it dark");
  form.set("quality", "high");
  form.set(
    "image[]",
    new Blob([new Uint8Array(Buffer.from(png, "base64"))]),
    "fox.png",
  );
  form.set("mask", new Blob([new Uint8Array([0, 255, 8])]), "mask.png");
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type");
  assert.ok(contentType);
  const multipart = await encoded.arrayBuffer();
  await bridge.setProviderRouting(provider);
  const edit = await send("images/edits", multipart, contentType);
  assert.equal(edit.status, 200);
  await edit.json();
  assert.deepEqual(latest(), {
    url: "/v1/claudex/images/edits",
    auth: "Bearer drawing-key",
    type: contentType,
    body: Buffer.from(multipart),
  });

  const refused = await fetch(`${bridge.url}/images/generations`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(refused.status, 401);
  assert.equal(seen.length, 2);
});

test("managed drawing conversations continue through both automatic endpoints after their model leaves the catalog", async (t) => {
  const { send, latest } = await imageBridge(t, "sub2api");
  const model = "gpt-image-retired";
  const image_url = `data:image/png;base64,${png}`;
  for (const editing of [false, true]) {
    const drawn = await send(
      "responses",
      JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Draw a fox." },
              ...(editing ? [{ type: "input_image", image_url }] : []),
            ],
          },
        ],
        stream: true,
      }),
    );
    assert.match(await drawn.text(), /response\.completed/);
    assert.equal(
      latest().url,
      editing ? "/v1/claudex/images/edits" : "/v1/claudex/images/generations",
    );
    assert.equal(latest().auth, "Bearer drawing-key");
    assert.deepEqual(JSON.parse(latest().body.toString()), {
      model,
      prompt: "Draw a fox.",
      n: 1,
      ...(editing ? { images: [{ image_url }] } : {}),
    });
  }

  const chat = await send(
    "responses",
    JSON.stringify({
      model: "gpt-6.1-sol",
      input: "Hello",
      stream: true,
    }),
  );
  await chat.text();
  assert.equal(latest().url, "/v1/responses");
  assert.equal(latest().auth, "Bearer gpt-key");
  assert.equal(JSON.parse(latest().body.toString()).model, "gpt-6.1-sol");
});

test("external providers receive explicit image models at ordinary Images endpoints", async (t) => {
  const { send, latest } = await imageBridge(t);
  const model = "gpt-image-2";
  const generated = await send(
    "images/generations",
    JSON.stringify({ model, prompt: "A fox" }),
  );
  assert.equal(generated.status, 200);
  await generated.json();
  assert.equal(latest().url, "/v1/images/generations");
  assert.equal(latest().auth, "Bearer primary-key");
  assert.equal(JSON.parse(latest().body.toString()).model, model);

  const drawn = await send(
    "responses",
    JSON.stringify({
      model,
      input: [{ role: "user", content: "A fox" }],
      stream: true,
    }),
  );
  assert.match(await drawn.text(), /response\.completed/);
  assert.equal(latest().url, "/v1/images/generations");
  assert.equal(latest().auth, "Bearer primary-key");
  assert.equal(JSON.parse(latest().body.toString()).model, model);
});

test("the api-image skill and its provider files land in the codex home", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = installApiImageSkill(home);
  for (const relative of Object.keys(apiImageFiles))
    assert.ok(fs.existsSync(path.join(root, ...relative.split("/"))), relative);
  assert.match(
    fs.readFileSync(path.join(root, "SKILL.md"), "utf8"),
    /^---\nname: api-image/,
  );
  const provider = writeImageProviderFiles(
    home,
    "http://127.0.0.1:5555/v1",
    "local-token",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")),
    {
      OPENAI_API_KEY: "local-token",
    },
  );
  assert.equal(provider.model_provider, "claudex");
  assert.equal(
    provider.model_providers.claudex.base_url,
    "http://127.0.0.1:5555/v1",
  );
  assert.equal(
    builtinImagegenSkill(home),
    path.join(home, "skills", ".system", "imagegen", "SKILL.md"),
  );
});

test("the installed api-image skill sends transparency and edit fidelity with its default model", async (t) => {
  const execute = promisify(execFile);
  let python: string | undefined;
  for (const command of ["python3", "python3.12", "python"]) {
    const usable = await execute(command, ["-c", "import tomllib"], {
      timeout: 5000,
    }).then(
      () => true,
      () => false,
    );
    if (usable) {
      python = command;
      break;
    }
  }
  if (!python)
    return t.skip("The installed image skill requires Python 3.11 or newer.");

  const { bridge, latest } = await imageBridge(t, "sub2api");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-skill-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const skill = installApiImageSkill(home);
  const config = writeImageProviderFiles(home, bridge.url, bridge.token);
  fs.writeFileSync(path.join(home, "config.toml"), TOML.stringify(config));
  const script = path.join(skill, "scripts", "generate_image.py");
  const bytes = Buffer.from(png, "base64");
  const reference = path.join(home, "reference.png");
  const mask = path.join(home, "mask.png");
  fs.writeFileSync(reference, bytes);
  fs.writeFileSync(mask, bytes);

  const generated = path.join(home, "generated.png");
  const common = [
    script,
    "--codex-home",
    home,
    "--prompt",
    "A fox",
    "--background",
    "transparent",
  ];
  await execute(python, [...common, "--out", generated], { timeout: 10000 });
  const generation = latest();
  assert.equal(generation.url, "/v1/claudex/images/generations");
  assert.equal(generation.auth, "Bearer drawing-key");
  assert.equal(JSON.parse(generation.body.toString()).model, "gpt-image-2");
  assert.equal(
    JSON.parse(generation.body.toString()).background,
    "transparent",
  );
  assert.deepEqual(fs.readFileSync(generated), bytes);

  const edited = path.join(home, "reference-2.png");
  const result = await execute(
    python,
    [
      ...common,
      "--image",
      reference,
      "--mask",
      mask,
      "--input-fidelity",
      "high",
      "--out",
      reference,
    ],
    { timeout: 10000 },
  );
  assert.equal(result.stdout.trim(), fs.realpathSync(edited));
  assert.deepEqual(fs.readFileSync(reference), bytes);
  const edit = latest();
  assert.equal(edit.url, "/v1/claudex/images/edits");
  assert.equal(edit.auth, "Bearer drawing-key");
  assert.ok(edit.type);
  const form = await new Response(new Uint8Array(edit.body), {
    headers: { "content-type": edit.type },
  }).formData();
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("background"), "transparent");
  assert.equal(form.get("input_fidelity"), "high");
  for (const field of ["image[]", "mask"]) {
    const file = form.get(field);
    assert.ok(file instanceof File);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  }
  assert.deepEqual(fs.readFileSync(edited), bytes);
});
