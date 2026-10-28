import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { build } from "esbuild";
import { Gateway } from "../../electron/engine/gateway";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import {
  allResponses,
  groupKeyId,
  mergeGroupModels,
  modelProtocol,
  providerKeyIds,
  routeForModel,
  type GroupModels,
} from "../../shared/provider-routes";
import { researchUnavailable } from "../../shared/research";
import type { ServiceCatalog } from "../../shared/model-catalog-api";
import type { Provider, UsageRecord } from "../../shared/types";

const openai: GroupModels = {
  groupId: 4,
  groupName: "openai",
  protocol: "responses",
  keyId: "sub2api",
  primary: true,
  models: ["gpt-5.5", "gpt-5.5-mini", "shared-model"],
};
const grok: GroupModels = {
  groupId: 11,
  groupName: "grok",
  protocol: "chat",
  keyId: groupKeyId("sub2api", 11),
  primary: false,
  models: ["grok-4", "shared-model", "grok-3"],
};
const other: GroupModels = {
  groupId: 7,
  groupName: "other",
  protocol: "chat",
  keyId: groupKeyId("sub2api", 7),
  primary: false,
  models: ["grok-3", "tagged"],
};

const item = (id: string, groupId?: number) => ({
  id,
  displayName: id,
  description: "",
  badges: [],
  sort: 0,
  hidden: false,
  isDefault: false,
  usageHint: "",
  ...(groupId ? { groupId } : {}),
});

test("group key ids sit next to the provider's own vault entry", () => {
  assert.equal(groupKeyId("sub2api", 11), "sub2api:g11");
  assert.deepEqual(
    providerKeyIds({
      id: "sub2api",
      routes: [
        { ...openai, models: [] },
        { ...grok, models: [] },
      ],
    }),
    ["sub2api", "sub2api:g11"],
  );
  assert.deepEqual(providerKeyIds({ id: "sub2api" }), ["sub2api"]);
});

test("each model goes to one group: the catalog's, else the plan group, else the smallest id", () => {
  const catalog: ServiceCatalog = {
    defaultModel: "gpt-5.5",
    items: [
      item("shared-model", 11), // the catalog names grok and grok lists it
      item("tagged", 99), // a group that does not list it: ignored
    ],
  };
  // Order of the input does not matter.
  const { models, routes } = mergeGroupModels([grok, other, openai], catalog);
  assert.deepEqual(models, [
    "gpt-5.5",
    "gpt-5.5-mini",
    "shared-model",
    "grok-3",
    "tagged",
    "grok-4",
  ]);
  assert.deepEqual(
    routes.map((route) => [route.groupId, route.primary, route.models]),
    [
      [4, true, ["gpt-5.5", "gpt-5.5-mini"]],
      [7, false, ["grok-3", "tagged"]], // grok-3: group 7 < group 11
      [11, false, ["shared-model", "grok-4"]],
    ],
  );
  // Without a catalog the plan group keeps a model several groups list.
  const plain = mergeGroupModels([openai, grok], null);
  assert.equal(
    routeForModel({ routes: plain.routes }, "shared-model")?.groupId,
    4,
  );
  // Deterministic.
  assert.deepEqual(mergeGroupModels([openai, other, grok], catalog), {
    models,
    routes,
  });
});

test("the protocol follows the selected model's group", () => {
  const { routes } = mergeGroupModels([openai, grok], null);
  const provider = { protocol: "responses" as const, routes };
  assert.equal(modelProtocol(provider, "gpt-5.5"), "responses");
  assert.equal(modelProtocol(provider, "grok-4"), "chat");
  assert.equal(modelProtocol(provider, "unknown"), "responses");
  assert.equal(modelProtocol({ protocol: "chat" }, "grok-4"), "chat");
  assert.equal(allResponses(provider), false);
  assert.equal(allResponses({ protocol: "responses" }), true);
  assert.equal(
    allResponses({ protocol: "responses", routes: [routes[0]] }),
    true,
  );
  // Research needs the Responses protocol of the selected model.
  const policy = {
    webSearch: true,
    research: { enabled: true },
  } as unknown as Parameters<typeof researchUnavailable>[0]["policy"];
  const base = { policy, mode: "chat" as const, provider };
  assert.equal(researchUnavailable({ ...base, model: "gpt-5.5" }), undefined);
  assert.equal(researchUnavailable({ ...base, model: "grok-4" }), "service");
});

async function upstream(t: TestContext) {
  const seen: { path?: string; authorization?: string; model?: string }[] = [];
  const server = http.createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({
      path: req.url,
      authorization: req.headers.authorization,
      model: body.model,
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (req.url?.endsWith("/chat/completions"))
      res.end(
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    else
      res.end(
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed" } })}\n\n`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen };
}

test("the gateway sends each model with its group's key and protocol", async (t) => {
  const { baseUrl, seen } = await upstream(t);
  const { models, routes } = mergeGroupModels([openai, grok], null);
  const provider: Provider = {
    id: "sub2api",
    name: "Claudex",
    baseUrl,
    protocol: "responses",
    model: "gpt-5.5",
    models,
    backend: "sub2api",
    routes,
  };
  const groupKeys: Record<string, string> = {
    [groupKeyId("sub2api", 11)]: "sk-grok-group-key",
  };
  const records: UsageRecord[] = [];
  const bridge = new Gateway(
    () => ({
      provider,
      apiKey: "sk-openai-plan-key",
      keyFor: (id) => groupKeys[id] ?? "",
    }),
    (record) => records.push(record),
  );
  await bridge.start();
  t.after(() => bridge.close());
  const post = (model: string) =>
    fetch(`${bridge.url}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify({ model, stream: true, input: "Hello" }),
    }).then((response) => response.text());

  await post("gpt-5.5");
  await post("grok-4");
  assert.deepEqual(seen, [
    {
      path: "/v1/responses",
      authorization: "Bearer sk-openai-plan-key",
      model: "gpt-5.5",
    },
    {
      path: "/v1/chat/completions",
      authorization: "Bearer sk-grok-group-key",
      model: "grok-4",
    },
  ]);
  assert.deepEqual(
    records.map((record) => [record.model, record.protocol]),
    [
      ["gpt-5.5", "responses"],
      ["grok-4", "chat"],
    ],
  );

  // Without the group's key (not provisioned yet) the plan group's key and
  // protocol are used; the service then refuses a model it does not serve.
  delete groupKeys[groupKeyId("sub2api", 11)];
  await post("grok-4");
  assert.deepEqual(seen[2], {
    path: "/v1/responses",
    authorization: "Bearer sk-openai-plan-key",
    model: "grok-4",
  });

  // A model no group lists is refused before reaching the service.
  const refused = await fetch(`${bridge.url}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify({ model: "claude-x", stream: true, input: "Hi" }),
  });
  assert.equal(refused.status, 403);
  assert.equal(seen.length, 3);
});

test("the provider child finds each group's key in the vault or in memory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  const { baseUrl, seen } = await upstream(t);
  const { models, routes } = mergeGroupModels([openai, grok], null);
  const provider: Provider = {
    id: "sub2api",
    name: "Claudex",
    baseUrl,
    protocol: "responses",
    model: "gpt-5.5",
    models,
    backend: "sub2api",
    routes,
  };
  const send = async (client: ProviderServiceClient, model: string) => {
    const response = await fetch(`${client.url}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: "hi", stream: true }),
    });
    await response.text();
  };
  const vaultKey = "cd".repeat(32);
  const stored = new ProviderServiceClient(
    script,
    root,
    provider,
    "",
    vaultKey,
    root,
  );
  try {
    await stored.setKeys(
      { sub2api: "sk-plan-in-vault", "sub2api:g11": "sk-grok-in-vault" },
      ["sub2api", "sub2api:g11"],
    );
    await stored.start();
    await send(stored, "grok-4");
    await send(stored, "gpt-5.5");
  } finally {
    await stored.close();
  }
  const memory = new ProviderServiceClient(
    script,
    root,
    provider,
    "sk-plan-in-memory",
  );
  try {
    memory.sessionGroupKeys = { "sub2api:g11": "sk-grok-in-memory" };
    await memory.start();
    assert.deepEqual(memory.sessionGroupKeys, {}, "handed over, not kept");
    await send(memory, "grok-4");
    // A key issued again replaces the group's key in the running child.
    await memory.setSessionKey("sk-plan-again", {
      "sub2api:g11": "sk-grok-again",
    });
    await send(memory, "grok-4");
    await send(memory, "gpt-5.5");
  } finally {
    await memory.close();
  }
  assert.deepEqual(
    seen.map((item) => [item.path, item.authorization]),
    [
      ["/v1/chat/completions", "Bearer sk-grok-in-vault"],
      ["/v1/responses", "Bearer sk-plan-in-vault"],
      ["/v1/chat/completions", "Bearer sk-grok-in-memory"],
      ["/v1/chat/completions", "Bearer sk-grok-again"],
      ["/v1/responses", "Bearer sk-plan-again"],
    ],
  );
});
