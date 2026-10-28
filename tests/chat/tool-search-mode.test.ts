/**
 * Connectors → Tool access for one conversation (customize 21, home 10/12):
 * the conversation's choice, else Capabilities', picks the model or its twin
 * that preloads connector tools; the gateway sends the real model upstream.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { codexModelCatalog } from "../../electron/engine/codex-model-catalog";
import { Engine } from "../../electron/engine/engine";
import { Gateway } from "../../electron/engine/gateway";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import {
  codexModelSlug,
  effectiveToolSearch,
  preloadedModelSuffix,
  upstreamModel,
} from "../../shared/tool-search-mode";

test("a conversation's choice wins; unset follows Capabilities", () => {
  assert.equal(effectiveToolSearch(undefined, {}), "on");
  assert.equal(
    effectiveToolSearch(undefined, { toolAccessMode: "loaded" }),
    "off",
  );
  assert.equal(
    effectiveToolSearch({ toolSearchMode: "on" }, { toolAccessMode: "loaded" }),
    "on",
  );
  assert.equal(effectiveToolSearch({ toolSearchMode: "off" }, {}), "off");
  assert.equal(codexModelSlug("gpt-5.5", "on"), "gpt-5.5");
  assert.equal(
    codexModelSlug("gpt-5.5", "off"),
    `gpt-5.5${preloadedModelSuffix}`,
  );
  assert.equal(upstreamModel(codexModelSlug("gpt-5.5", "off")), "gpt-5.5");
  assert.equal(upstreamModel("gpt-5.5"), "gpt-5.5");
});

test("every catalog model has a hidden twin with tool search off", () => {
  const { models } = codexModelCatalog();
  const real = models.filter(
    (model) => !String(model.slug).endsWith(preloadedModelSuffix),
  );
  for (const model of real) {
    const twin = models.find(
      (item) => item.slug === `${model.slug}${preloadedModelSuffix}`,
    );
    assert.ok(twin, String(model.slug));
    assert.equal(twin!.supports_search_tool, false);
    assert.equal(twin!.visibility, "none");
  }
  assert.equal(models.length, real.length * 2);
});

function setup() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-tool-search-")),
  );
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  const store = new Store(profile);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  const turns: any[] = [];
  let threads = 0;
  engine.rpc = {
    async call(method: string, params: any) {
      if (method === "turn/start") turns.push(structuredClone(params));
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${++threads}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${turns.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return {
    engine,
    store,
    turns,
    send: (extra: Record<string, unknown> = {}) =>
      engine.send({
        text: "Hello",
        mode: "chat",
        attachments: [],
        providerId: "default",
        model: "m",
        ...extra,
      } as any),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("turns name the twin when the conversation (or Capabilities) preloads tools", async () => {
  const env = setup();
  try {
    const first = await env.send({ toolSearchMode: "off" });
    assert.equal(first.toolSearchMode, "off");
    assert.equal(env.turns.at(-1).model, `m${preloadedModelSuffix}`);
    await env.send();
    assert.equal(env.turns.at(-1).model, "m");
    // Unset follows Capabilities; a conversation's "on" still wins.
    env.store.settings = { ...env.store.settings, toolAccessMode: "loaded" };
    await env.send();
    assert.equal(env.turns.at(-1).model, `m${preloadedModelSuffix}`);
    await env.send({ toolSearchMode: "on" });
    assert.equal(env.turns.at(-1).model, "m");
  } finally {
    env.close();
  }
});

test("the gateway sends the real model upstream", async (t) => {
  let seen: string | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen = JSON.parse(Buffer.concat(chunks).toString()).model;
      res.writeHead(400, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const gateway = new Gateway(() => ({
    provider: {
      id: "test",
      name: "Mock",
      model: "gpt-5.5",
      models: [],
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "responses",
    },
    apiKey: "secret",
  }));
  await gateway.start();
  t.after(() => gateway.close());
  await fetch(`${gateway.url}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gateway.token}`,
    },
    body: JSON.stringify({
      model: `gpt-5.5${preloadedModelSuffix}`,
      input: [],
      stream: true,
    }),
  }).then((response) => response.text());
  assert.equal(seen, "gpt-5.5");
});
