import test from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  HIWONDER_KNOWLEDGE_SERVER,
  HUANER_TECH,
  cleanBaseIds,
  hiwonderKnowledgeRelayUrl,
  knowledgeBasesFrom,
  knowledgeRoute,
  knowledgeRoutePattern,
} from "../../shared/knowledge-api";
import {
  knowledgeExtension,
  registerKnowledgeExtension,
} from "../../electron/connectors/knowledge-extension";
import { Engine } from "../../electron/engine/engine";
import { Gateway } from "../../electron/engine/gateway";
import { Store } from "../../electron/store/store";
import { newConversation } from "../../electron/engine/new-conversation";
import {
  loadKnowledgeCatalog,
  loadKnowledgeOffer,
} from "../../electron/ipc/knowledge";
import { openPolicy } from "../../shared/client-policy";
import type { Provider } from "../../shared/types";
import {
  CodexHost,
  MockResponses,
  reachableTools,
  tempRoot,
  toolPlan,
  until,
} from "../spikes/harness";

test("the service's list is checked", () => {
  const bases = knowledgeBasesFrom({
    code: 0,
    data: {
      bases: [
        {
          id: "huaner-tech",
          name: "幻尔科技知识库",
          description: "手册",
          available: true,
        },
        { id: "Bad Id", name: "x" },
        { id: "no-name", name: " " },
      ],
    },
  });
  assert.deepEqual(bases, [
    {
      id: "huaner-tech",
      name: "幻尔科技知识库",
      description: "手册",
      available: true,
    },
  ]);
  assert.deepEqual(knowledgeBasesFrom(null), []);
});

test("a conversation names valid, unique bases", () => {
  assert.deepEqual(cleanBaseIds(["huaner-tech", "huaner-tech", "../x", 3]), [
    "huaner-tech",
  ]);
  assert.equal(
    knowledgeRoutePattern.exec("/v1/claudex/knowledge/huaner-tech/mcp")?.[1],
    "huaner-tech",
  );
  assert.equal(
    knowledgeRoutePattern.exec("/v1/claudex/knowledge/../mcp"),
    null,
  );
});

function provider(baseUrl: string): Provider {
  return {
    id: "claudex",
    name: "Claudex",
    backend: "sub2api",
    baseUrl,
    protocol: "responses",
    model: "grok-4",
    models: ["grok-4"],
  };
}

test("the selected Hiwonder tools follow session and policy changes on the real Codex thread", async (t) => {
  const root = tempRoot("hiwonder-mcp");
  const mock = await new MockResponses().start();
  const calls: string[] = [];
  let rejectedStartup = false;
  const upstream = http.createServer(async (req, res) => {
    if (req.url !== `/service${knowledgeRoute(HUANER_TECH)}`)
      return void res.writeHead(404).end();
    if (req.headers.authorization !== "Bearer account-key")
      return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (msg.id === undefined) return void res.writeHead(202).end();
    let result: object;
    switch (msg.method) {
      case "initialize":
        if (rejectedStartup)
          return void res.writeHead(429, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Too many requests" }));
        result = {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-hiwonder", version: "1" },
        };
        break;
      case "tools/list":
        await new Promise(resolve => setTimeout(resolve, 1400));
        result = {
          tools: ["rag_search", "rag_read", "unexpected_write"].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object" },
          })),
        };
        break;
      case "tools/call":
        calls.push(msg.params.name);
        result = {
          content: [{ type: "text", text: "Manual for synthetic robot" }],
        };
        break;
      default:
        result = {};
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const serviceBase = `http://127.0.0.1:${address.port}/service`;
  const service = provider(`${serviceBase}/v1`);
  const gateway = new Gateway(() => ({
    provider: service,
    apiKey: "account-key",
  }));
  await gateway.start();
  const store = new Store(root);
  const host = new CodexHost(
    path.join(root, "codex-home"),
    mock,
    {},
    { CLAUDEX_GATEWAY_TOKEN: gateway.token },
  );
  t.after(async () => {
    await host.stop();
    store.flush();
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await host.start();
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.rpc = host.rpc;
  engine.policy = () => openPolicy;
  engine.extensions.add(knowledgeExtension());
  const extensionContext = engine.turnContext.bind(engine);
  engine.turnContext = (...args) => ({
    ...extensionContext(...args),
    gatewayUrl: gateway.url,
  });
  store.settings.mcpServers[HIWONDER_KNOWLEDGE_SERVER] = {
    url: "http://invalid.localhost/mcp",
  };
  assert.equal(
    JSON.parse(engine.mcpConfig())[HIWONDER_KNOWLEDGE_SERVER],
    undefined,
  );
  const cwd = path.join(root, "workspace");
  const conversation = newConversation(
    {
      mode: "chat",
      text: "",
      attachments: [],
      model: service.model,
      providerId: service.id,
    },
    service,
    cwd,
    store.settings,
  );
  const options = () => ({
    ...engine.threadOptions(conversation, service, service.model, "chat"),
    modelProvider: "spike",
  });
  const config = () => options().config;
  const workflow = () =>
    engine.extensions.turnContext(
      engine.turnContext(conversation, service, service.model, "chat"),
    )?.["knowledge.workflow"]?.value;
  const run = async (threadId: string, names: string[]) => {
    const start = mock.requests.length;
    mock.script = toolPlan(names.map((suffix) => ({ suffix })));
    const turn = await host.turn(
      threadId,
      "Use the Hiwonder knowledge tools if available.",
    );
    assert.equal(turn.completed.turn.status, "completed");
    return mock.requests.slice(start).flatMap(reachableTools);
  };
  const enabledKey = `mcp_servers.${HIWONDER_KNOWLEDGE_SERVER}.enabled`;
  const other = await host.thread(service.model, cwd, { config: config() });
  assert.equal(workflow(), undefined);
  assert.ok(
    !(await run(other, [])).some((name) =>
      name.includes(HIWONDER_KNOWLEDGE_SERVER),
    ),
  );
  conversation.knowledgeBases = [HUANER_TECH];
  assert.equal(config()[enabledKey], true);
  conversation.connectorOverrides = { [HIWONDER_KNOWLEDGE_SERVER]: true };
  await engine.ensureThread(conversation, options());
  const thread = conversation.threadId;
  assert.ok(thread);
  assert.match(workflow() ?? "", /rag_search/);
  const tools = await run(thread, ["rag_search", "rag_read"]);
  assert.ok(tools.some((name) => name.endsWith("/rag_search")));
  assert.ok(tools.some((name) => name.endsWith("/rag_read")));
  assert.ok(!tools.some((name) => name.endsWith("/unexpected_write")));
  assert.deepEqual(calls, ["rag_search", "rag_read"]);
  conversation.connectorToolOverrides = {
    [HIWONDER_KNOWLEDGE_SERVER]: { rag_read: false },
  };
  await engine.ensureThread(conversation, options());
  assert.doesNotMatch(workflow() ?? "", /rag_read/);
  assert.ok(
    !(await run(thread, ["rag_search"])).some((name) =>
      name.endsWith("/rag_read"),
    ),
  );
  assert.deepEqual(calls, ["rag_search", "rag_read", "rag_search"]);
  conversation.connectorToolOverrides = {
    [HIWONDER_KNOWLEDGE_SERVER]: { rag_read: false, rag_search: false },
  };
  assert.equal(config()[enabledKey], false);
  assert.equal(workflow(), undefined);
  delete conversation.connectorToolOverrides;
  engine.policy = () => ({ ...openPolicy, connectors: [] });
  assert.equal(config()[enabledKey], false);
  await engine.ensureThread(conversation, options());
  assert.ok(
    !(await run(thread, [])).some((name) =>
      name.includes(HIWONDER_KNOWLEDGE_SERVER),
    ),
  );
  const blocked = await host.thread(service.model, cwd, { config: config() });
  assert.ok(
    !(await run(blocked, [])).some((name) =>
      name.includes(HIWONDER_KNOWLEDGE_SERVER),
    ),
  );
  engine.policy = () => ({
    ...openPolicy,
    connectors: [
      {
        name: HIWONDER_KNOWLEDGE_SERVER,
        url: hiwonderKnowledgeRelayUrl(serviceBase),
      },
    ],
    approvalsAlwaysAllow: false,
  });
  assert.equal(
    config()[
      `mcp_servers.${HIWONDER_KNOWLEDGE_SERVER}.default_tools_approval_mode`
    ],
    "prompt",
  );
  engine.policy = () => openPolicy;
  await engine.ensureThread(conversation, options());
  assert.ok((await run(thread, [])).some((name) => name.endsWith("/rag_read")));
  conversation.connectorOverrides = { [HIWONDER_KNOWLEDGE_SERVER]: false };
  await engine.ensureThread(conversation, options());
  assert.equal(workflow(), undefined);
  assert.ok(
    !(await run(thread, [])).some((name) =>
      name.includes(HIWONDER_KNOWLEDGE_SERVER),
    ),
  );
  assert.deepEqual(calls, ["rag_search", "rag_read", "rag_search"]);

  store.settings.providers = [service];
  engine.ensure = async () => {};
  const threadOptions = engine.threadOptions.bind(engine);
  engine.threadOptions = (...args) => ({
    ...threadOptions(...args),
    modelProvider: "spike",
  });
  rejectedStartup = true;
  const requests = mock.requests.length;
  const failed = await engine.send({
    mode: "chat",
    text: "Read the robot manual.",
    attachments: [],
    providerId: service.id,
    model: service.model,
    connectorOverrides: { [HIWONDER_KNOWLEDGE_SERVER]: true },
  });
  const failure = new Store(root).conversation(failed.id).turns[0];
  assert.equal(failure?.status, "failed");
  assert.equal(failure?.sendFailed, true);
  assert.match(failure?.error ?? "", /knowledge base.*(too many requests|can't be reached)/);
  assert.equal(mock.requests.length, requests);

  rejectedStartup = false;
  mock.script = toolPlan([{ suffix: "rag_search" }, { suffix: "rag_read" }]);
  const sent = await engine.retryResponse(failed.id, failure!.id, service.id, service.model);
  assert.equal(sent.id, failed.id);
  assert.equal(sent.turns.at(-1)?.prompt, failure?.prompt);
  await until(() => calls.length === 5, "both tools in the same conversation after retry");
  assert.deepEqual(calls.slice(-2), ["rag_search", "rag_read"]);
});

test("the catalog keeps the original profile's token and drops a response after account switch", async (t) => {
  const tokens: (string | undefined)[] = [];
  const row = {
    id: HUANER_TECH,
    name: "Hiwonder",
    description: "Manuals",
    available: true,
  };
  let delayReply = false;
  let pendingReply: http.ServerResponse | undefined;
  const service = http.createServer((req, res) => {
    assert.equal(req.url, "/api/v1/claudex/knowledge");
    tokens.push(req.headers.authorization);
    if (delayReply) pendingReply = res;
    else
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ bases: [row] }));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    service.closeAllConnections();
    await new Promise<void>((resolve) => service.close(() => resolve()));
  });
  const address = service.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const remote = (token: string) => ({
    ready: true,
    backend: {
      accounts: { baseUrl },
      session: {
        authorized: <T>(call: (token: string) => Promise<T>) => call(token),
      },
    },
  });
  const context = {
    remote: remote("first-account"),
    activeAccount: { id: "first" },
    accountActivationIdentity: {},
    policy: () => openPolicy,
  };
  assert.deepEqual(await loadKnowledgeOffer(context), {
    baseUrl,
    bases: [row],
  });
  context.policy = () => ({ ...openPolicy, connectors: [] });
  assert.deepEqual(await loadKnowledgeCatalog(context), []);
  delayReply = true;
  const received = once(service, "request");
  const inflight = loadKnowledgeOffer(context);
  await received;
  assert.ok(pendingReply);
  context.remote = remote("second-account");
  context.activeAccount = { id: "second" };
  context.accountActivationIdentity = {};
  delayReply = false;
  pendingReply
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify({ bases: [row] }));
  await assert.rejects(inflight, /account changed/i);
  assert.deepEqual(await loadKnowledgeOffer(context), {
    baseUrl,
    bases: [row],
  });
  assert.deepEqual(tokens, [
    "Bearer first-account",
    "Bearer first-account",
    "Bearer first-account",
    "Bearer second-account",
  ]);
});

test("the knowledge gateway preserves service refusal and rate-limit details and bounds a stalled response", async (t) => {
  let status = 401;
  const upstream = http.createServer((_req, res) => {
    if (status === 0) return;
    res
      .writeHead(status, {
        "Content-Type": "application/json",
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      })
      .end(
        JSON.stringify({
          error: {
            code: status === 429 ? "KNOWLEDGE_RATE_LIMITED" : "UNAUTHORIZED",
          },
        }),
      );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const service = provider(`http://127.0.0.1:${address.port}/v1`);
  const gateway = new Gateway(() => ({
    provider: service,
    apiKey: "account-key",
  }));
  await gateway.start();
  t.after(async () => {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const url = new URL(knowledgeRoute(HUANER_TECH), gateway.url);
  const read = () =>
    fetch(url, { headers: { Authorization: `Bearer ${gateway.token}` } });
  assert.equal((await fetch(url)).status, 401);
  const refused = await read();
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: { code: "UNAUTHORIZED" } });
  status = 429;
  const throttled = await read();
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "60");
  assert.deepEqual(await throttled.json(), {
    error: { code: "KNOWLEDGE_RATE_LIMITED" },
  });
  status = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const received = once(upstream, "request");
  const inflight = read();
  await received;
  t.mock.timers.tick(120_000);
  t.mock.timers.reset();
  const timedOut = await inflight;
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), {
    error: { message: "The knowledge base timed out." },
  });
});

// The web runner runs each chat in a space's engine (Engine.createPeer):
// those engines get the extension too.
test("the extension reaches the spaces' engines", () => {
  const added: string[] = [];
  let activated: (() => void) | undefined;
  let deactivating: (() => void) | undefined;
  const engine = {
    extensions: {
      has: () => false,
      add: (e: { id: string }) => {
        added.push(e.id);
        return () => added.splice(added.indexOf(e.id), 1);
      },
    },
    peerExtensions: [] as { id: string }[],
  };
  registerKnowledgeExtension({
    engine,
    onAccountActivated: (f: () => void) => (activated = f),
    onAccountDeactivating: (f: () => void) => (deactivating = f),
  } as any);
  activated!();
  assert.deepEqual(added, ["knowledge"]);
  assert.deepEqual(
    engine.peerExtensions.map((e) => e.id),
    ["knowledge"],
  );
  activated!();
  assert.equal(engine.peerExtensions.length, 1, "no second copy");
  deactivating!();
  assert.deepEqual(added, []);
  assert.deepEqual(engine.peerExtensions, []);
});
