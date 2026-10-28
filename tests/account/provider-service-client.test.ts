import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { ChildProcess } from "node:child_process";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import type { Provider } from "../../shared/types";
import {
  parseRequestLimits,
  type RequestLimits,
} from "../../server/operator-limits";

test("separate localhost process forwards model requests and owns usage records", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-provider-service-"),
  );
  const script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
  });
  let receivedAuthorization = "";
  const upstream = http.createServer((request, response) => {
    receivedAuthorization = String(request.headers.authorization ?? "");
    if (request.url === "/v1/models")
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    else {
      response.writeHead(200, { "content-type": "text/event-stream" }).end(
        "data: " +
          JSON.stringify({
            type: "response.completed",
            response: { usage: { input_tokens: 8, output_tokens: 3 } },
          }) +
          "\n\n",
      );
    }
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
    model: "fixture-model",
    models: ["fixture-model"],
  };
  const client = new ProviderServiceClient(
    script,
    root,
    provider,
    "synthetic-upstream-secret",
  );
  try {
    const url = await client.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const response = await fetch(`${url}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        input: "synthetic prompt",
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
    assert.equal(receivedAuthorization, "Bearer synthetic-upstream-secret");
    const summary = await client.usageSummary();
    assert.deepEqual(summary.total, {
      requests: 1,
      successful: 1,
      failed: 0,
      unmetered: 0,
      inputTokens: 8,
      outputTokens: 3,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    const log = fs.readFileSync(
      path.join(root, "usage", new Date().toISOString().slice(0, 7) + ".jsonl"),
      "utf8",
    );
    assert.doesNotMatch(log, /synthetic prompt|synthetic-upstream-secret/);
    const tested = await client.testProvider(
      provider,
      "synthetic-upstream-secret",
    );
    assert.deepEqual(tested.models, ["fixture-model"]);
    const child = (client as unknown as { child?: ChildProcess }).child;
    assert(child);
    await client.close();
    assert(
      child.exitCode !== null || child.signalCode !== null,
      "close must wait for the provider service process to exit",
    );
  } finally {
    await client.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function tokenLimitRestored(
  configured: Partial<RequestLimits>,
  message: RegExp,
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-provider-limit-"),
  );
  const script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
  });
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests++;
    response.writeHead(200, { "content-type": "text/event-stream" }).end(
      "data: " +
        JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 8, output_tokens: 3 } },
        }) +
        "\n\n",
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const provider: Provider = {
    id: "fixture",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    protocol: "responses",
    model: "fixture-model",
    models: ["fixture-model"],
  };
  const limits = parseRequestLimits(configured);
  const post = (client: ProviderServiceClient) =>
    fetch(`${client.url}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        input: "synthetic",
        stream: true,
      }),
    });
  let client = new ProviderServiceClient(
    script,
    root,
    provider,
    "synthetic-key",
    undefined,
    root,
    limits,
  );
  try {
    await client.start();
    const first = await post(client);
    assert.equal(first.status, 200);
    await first.text();
    assert.equal((await client.usageSummary()).total.inputTokens, 8);
    const denied = await post(client);
    assert.equal(denied.status, 429);
    assert.match((await denied.json()).error.message, message);
    assert.equal(upstreamRequests, 1);
    await client.close();
    client = new ProviderServiceClient(
      script,
      root,
      provider,
      "synthetic-key",
      undefined,
      root,
      limits,
    );
    await client.start();
    const afterRestart = await post(client);
    assert.equal(afterRestart.status, 429);
    await afterRestart.text();
    assert.equal(upstreamRequests, 1);
  } finally {
    await client.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("provider service applies account token limits and restores used tokens after restart", () =>
  tokenLimitRestored({ dailyTokenLimit: 10 }, /daily token limit/));
test("provider service enforces the weekly token limit and seeds this week's usage after restart", () =>
  tokenLimitRestored({ weeklyTokenLimit: 10 }, /weekly token limit/));
