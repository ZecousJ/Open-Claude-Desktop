import assert from "node:assert/strict";
import { protectedToolFailure } from "./support/f040-auth-rejection";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { ConnectorClients } from "../electron/connectors/connector-clients";
import { ConnectorOAuth } from "../runner/src/connector-oauth";
import { ConnectorTokens } from "../runner/src/connectors";
import { CloudStore } from "../runner/src/cloud-store";
import { officialUiRead } from "../runner/src/official-ui-read";
import { defaultGuardOptions } from "../runner/src/method-guard";
import { encodeWireValue, decodeWireValue } from "../shared/web-wire";
import {
  officialUiActionPath,
  officialUiCapabilitiesPath,
  type OfficialUiReadRequest,
} from "../shared/official-ui-web";
import { organizationUuid } from "../electron/official-ui/api/context";
import { officialConnectorAuthTarget } from "../shared/official-ui-web";
import { connectorUuid } from "../electron/official-ui/api/connectors";
import { permissionKeys } from "../electron/official-ui/api/connectors";
import { deepCreate, registryFor, STREAM_TIMELINE_PATH } from "../electron/official-ui/api/timeline";
import { saveSessionConnectorPreference } from "../electron/ipc/session-connector-preference";
import { negotiatedOfficialAction } from "../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";
import { openPolicy, type ClientPolicy } from "../shared/client-policy";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH } from "../shared/knowledge-api";
import { webErrorCodes } from "../shared/web-protocol";
import type { Conversation } from "../shared/types";
import type { McpServerState } from "../shared/settings-desktop-api";
import {
  memoryWebstore,
  useElectronShim,
} from "./runner/runner-core-support.test";

useElectronShim();
const { WebMcpConfig } = await import("../runner/src/web-app-support");
const { registerSettingsConnectorHandlers } =
  await import("../electron/ipc/settings-desktop-connectors");
const id = "22222222-2222-4222-8222-222222222222";
const origin = "https://test.example";
const server: McpServerState = {
  name: "wiki",
  url: "https://example.test/mcp",
  state: "ready",
  tools: 2,
  toolList: [
    { name: "search", description: "Search docs", enabled: true, definition: { name: "search" } },
    { name: "read", description: "Read docs", enabled: true, definition: { name: "read" } },
  ],
};
const [search, read] = server.toolList!.map((tool) =>
  permissionKeys(server, tool),
);
const route = (owner: string) =>
  "/api/organizations/" + organizationUuid(owner) + "/chat_conversations/" + id;
const knowledge = HIWONDER_KNOWLEDGE_SERVER;
const ragSearch = `${connectorUuid(knowledge)}:rag_search`;
const ragRead = `${connectorUuid(knowledge)}:rag_read`;
const knowledgeBase = { id: HUANER_TECH, name: "Hiwonder", description: "Product manuals", available: true };

async function hostKnowledge(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  let available = false;
  const bases = async () => [{ ...knowledgeBase, available }];
  const service = http.createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/claudex/knowledge");
    assert.equal(req.headers.authorization, "Bearer knowledge-fixture");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ bases: await bases() }));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    service.closeAllConnections();
    await new Promise<void>((resolve) => service.close(() => resolve()));
  });
  const address = service.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(f.ctx, {
    accountActivationIdentity: f.ctx.accountGeneration(),
    remote: {
      ready: true,
      backend: {
        accounts: { baseUrl: `http://127.0.0.1:${address.port}` },
        session: { authorized: <T>(call: (token: string) => Promise<T>) => call("knowledge-fixture") },
      },
    },
  });
  Object.assign(f.ipcContext, { knowledgeCatalog: bases });
  return () => { available = true; };
}

async function fixture(t: TestContext, web = memoryWebstore(), userId = 1) {
  const owner = "owner-" + userId;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-web-"));
  const store = await CloudStore.open({
    root,
    userId,
    transport: web,
    log() {},
  });
  const row: Conversation = {
    id,
    title: "Saved chat",
    mode: "chat",
    providerId: "provider",
    model: "model",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [],
    environment: { kind: "space", spaceId: "fixture" },
  };
  store.conversations.push(row);
  store.settings.mcpServers = { wiki: { url: server.url } };
  store.settings.providers = [{
    id: "provider", name: "Fixture", baseUrl: "https://example.test/v1",
    protocol: "responses", model: "model", models: ["model"],
  }];
  await store.sync();
  let identity = {};
  let policy = openPolicy;
  const ctx = {
    userId,
    activeAccount: { id: owner },
    store,
    officialSessionIdentity: () => identity,
    accountGeneration: () => identity,
    policy: () => policy,
    setAccessToken() {},
    onEvent: () => () => {},
    log() {},
    appVersion: "test",
    settingsChanged() {},
    replyFeedback: { all: () => ({}) },
    engineRunning: () => false,
    settingsListeners: { emit() {} },
  };
  const mcpConfig = new WebMcpConfig(ctx as never);
  Object.assign(ctx, { mcpConfig });
  const ipcContext = { ...ctx, mcpConfig };
  const methods = new Map<string, (...args: unknown[]) => unknown>();
  const sends: Array<{ input: unknown; saved: Conversation["connectorToolOverrides"] }> = [];
  const mcpServers = async (_startLocal?: boolean, refreshName?: string) =>
    ("connectors" in ctx ? mcpConfig.readCatalog(refreshName) : { servers: [server], configPath: "" });
  registerSettingsConnectorHandlers({
    ctx: ipcContext,
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      methods.set(name, handler),
    connectorLease: () => ({ assertCurrent() {}, wait: <T>(promise: Promise<T>) => promise }),
    connectorHistory: () => ({ begin() {}, complete() {} }),
    mcpServers,
  } as never);
  const dispatcher = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: true,
    },
    guard: defaultGuardOptions,
    context: () => ctx,
    contextFor: async () => ctx,
    now: () => 1,
    async run(frame: { method: string; args: unknown }, expected?: { officialConnectorLifecycle?: { assertCurrent(): void } }) {
      const args = decodeWireValue(frame.args) as unknown[];
      if (frame.method === "mcpServers") return mcpServers();
      if (frame.method === "snapshot")
        return {
          settings: store.settings,
          projects: [],
          conversations: store.conversations,
        };
      if (frame.method === "conversationTurns")
        return { turns: row.turns, savedBranches: [] };
      if (frame.method === "send") {
        const input = args[0] as { conversationId?: string };
        const saved = store.conversations.find((item) => item.id === input.conversationId);
        sends.push({ input, saved: saved?.connectorToolOverrides });
        return saved;
      }
      if (frame.method === "updateConversation")
        return saveSessionConnectorPreference(
          ipcContext as never,
          String(args[0]),
          args[1],
        );
      const handler = methods.get(frame.method);
      if (handler) {
        const lifecycle = expected?.officialConnectorLifecycle;
        lifecycle?.assertCurrent();
        return handler(...args, ...(lifecycle ? [lifecycle.assertCurrent] : []));
      }
      throw Error("Unexpected method " + frame.method);
    },
  };
  const run = (request: OfficialUiReadRequest) =>
    officialUiRead(
      dispatcher as never,
      {
        t: "call",
        id: "test",
        user: { id: userId, accessToken: "synthetic" },
        method:
          request.path === STREAM_TIMELINE_PATH ||
          (request.method === "GET" && !officialConnectorAuthTarget(request.method, request.path))
            ? "officialUiRead" : "officialUiAction",
        args: encodeWireValue([request]),
      } as never,
    );
  const cap = async () =>
    JSON.parse(
      Buffer.from(
        (await run({ method: "GET", path: officialUiCapabilitiesPath })).body,
      ).toString(),
    );
  const action = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: String(userId),
    isCurrent: () => true,
    read: run,
    action: run,
  });
  const fetch = createOfficialReadFetch(
    origin,
    run,
    globalThis.fetch,
    undefined,
    action,
  );
  const write = (method: "PUT" | "PATCH", url: string, body: unknown) =>
    fetch(origin + url, {
      method,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    owner,
    ctx,
    ipcContext,
    mcpConfig,
    web,
    row,
    store,
    run,
    cap,
    fetch,
    write,
    sends,
    dispatcher,
    setPolicy(value: ClientPolicy) {
      policy = value;
    },
    retire() {
      identity = {};
    },
  };
}

test("original Web send applies its owned MCP choices before dispatch and never replays a send", async (t) => {
  const f = await fixture(t);
  const registry = registryFor(path.resolve("build/official-ui"));
  const schema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const reply = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const send = async (conversationId: string, version: bigint, tools: Record<string, boolean>) => {
    const body = toBinary(schema, deepCreate(schema, {
    header: { conversationId, mutationId: { sessionId: "f046-browser", version } },
    action: {
      case: "sendMessage",
      value: {
        messageId: "33333333-3333-4333-8333-333333333333",
        assistantMessageId: "44444444-4444-4444-8444-444444444444",
        text: "Browser sends with the selected tool disabled.",
        settingsUpdate: { settings: { enabledMcpTools: { tools } } },
      },
    },
    }));
    const result = await f.fetch(origin + officialUiActionPath, {
      method: "POST", headers: { "Content-Type": "application/proto" }, body,
    });
    assert.equal(result.status, 200);
    const ack = fromBinary(reply, new Uint8Array(await result.arrayBuffer()));
    return (ack as { ack?: { outcome?: { case?: string } } }).ack?.outcome?.case;
  };
  const choices = { [search.enabled]: false, [read.enabled]: true };
  assert.equal(await send(id, 1n, choices), "applied");
  assert.equal(await send(id, 1n, choices), "applied");
  assert.equal(f.sends.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0]!.saved)), { wiki: { search: false } });
  assert.equal(await send(id, 2n, { [search.approved]: true }), "error");
  assert.equal(f.sends.length, 1);
  const newId = "55555555-5555-4555-8555-555555555555";
  assert.equal(await send(newId, 3n, choices), "applied");
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends[1]!.input, {
    newConversationId: newId, mode: "chat", providerId: "provider", model: "model",
    text: "Browser sends with the selected tool disabled.",
    attachments: [], connectorToolOverrides: { wiki: { search: false } },
  });
});

test("original Chat preference reopens legacy knowledge and saves each tool only in its conversation", async (t) => {
  const f = await fixture(t);
  f.row.knowledgeBases = [HUANER_TECH];
  const makeAvailable = await hostKnowledge(t, f);
  const url = route(f.owner);
  const read = async () => (await (await f.fetch(origin + url)).json()).settings.enabled_mcp_tools;
  const save = (tools: Record<string, boolean>) => f.write("PUT", url + "?rendering_mode=raw", {
    settings: { enabled_mcp_tools: tools },
  });
  assert.deepEqual(await read(), { [ragSearch]: true, [ragRead]: true });
  assert.equal((await save({ [ragSearch]: false })).status, 200);
  assert.deepEqual(await read(), { [ragSearch]: false, [ragRead]: true });
  assert.equal((await save({ [ragRead]: false })).status, 200);
  assert.deepEqual(await read(), { [ragSearch]: false, [ragRead]: false });
  assert.equal((await save({ [ragRead]: true })).status, 409);
  assert.equal((await save({ [`${connectorUuid(knowledge)}:other_tool`]: true })).status, 400);
  assert.equal((await save({ [ragRead]: false })).status, 200);
  makeAvailable();
  assert.equal((await save({ [ragRead]: true })).status, 200);
  assert.deepEqual(await read(), { [ragSearch]: false, [ragRead]: true });
  assert.deepEqual(f.store.settings.mcpServers, { wiki: { url: server.url } });
  assert.equal(f.sends.length, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f164-reopen-"));
  const reopened = await CloudStore.open({ root, userId: 1, transport: f.web, log() {} });
  t.after(async () => {
    await reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const persisted = reopened.conversation(id);
  assert.deepEqual(persisted.connectorOverrides, { [knowledge]: true });
  assert.deepEqual(persisted.connectorToolOverrides, { [knowledge]: { rag_search: false, rag_read: true } });
});

test("original Chat first PerformAction commits only the explicitly selected knowledge tool", async (t) => {
  const f = await fixture(t);
  const makeAvailable = await hostKnowledge(t, f);
  const registry = registryFor(path.resolve("build/official-ui"));
  const input = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const output = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const newId = "55555555-5555-4555-8555-555555555555";
  const send = async (version: bigint, enabled: boolean) => {
    const result = await f.fetch(origin + officialUiActionPath, {
      method: "POST",
      headers: { "Content-Type": "application/proto" },
      body: toBinary(input, deepCreate(input, {
        header: { conversationId: newId, mutationId: { sessionId: "hiwonder-start", version } },
        action: { case: "sendMessage", value: {
          messageId: "33333333-3333-4333-8333-333333333333",
          assistantMessageId: "44444444-4444-4444-8444-444444444444",
          text: "查找教材",
          settingsUpdate: { settings: { enabledMcpTools: { tools: { [ragSearch]: enabled, [ragRead]: false } } } },
        } },
      })),
    });
    assert.equal(result.status, 200);
    const reply = fromBinary(output, new Uint8Array(await result.arrayBuffer()));
    return (reply as { ack?: { outcome?: { case?: string } } }).ack?.outcome?.case;
  };
  assert.equal(await send(1n, true), "error");
  assert.equal(f.sends.length, 0);
  assert.equal(await send(2n, false), "applied");
  assert.deepEqual(f.sends[0]?.input, {
    newConversationId: newId, mode: "chat", text: "查找教材", attachments: [], providerId: "provider", model: "model",
  });
  makeAvailable();
  assert.equal(await send(3n, true), "applied");
  assert.deepEqual(f.sends[1]?.input, {
    newConversationId: newId, mode: "chat", text: "查找教材", attachments: [], providerId: "provider", model: "model",
    connectorOverrides: { [knowledge]: true },
    connectorToolOverrides: { [knowledge]: { rag_search: true, rag_read: false } },
  });
});

test("original C3 Chat connector toggle persists without sending a message", async (t) => {
  const f = await fixture(t);
  const registry = registryFor(path.resolve("build/official-ui"));
  const schema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const reply = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const toggle = (conversationId: string, version: bigint, settings: object) =>
    f.fetch(origin + officialUiActionPath, {
      method: "POST", headers: { "Content-Type": "application/proto" },
      body: toBinary(schema, deepCreate(schema, {
        header: { conversationId, mutationId: { sessionId: "f042-browser", version } },
        action: { case: "updateConversationSettings", value: { settings } },
      })),
    });
  const choices = (enabled: boolean) => ({ enabledMcpTools: { tools: { [search.enabled]: enabled } } });
  const expectAck = async (response: Response, version: bigint, outcome: "applied" | "error") => {
    assert.equal(response.status, 200, await response.clone().text());
    const message = fromBinary(reply, new Uint8Array(await response.arrayBuffer()));
    assert.ok("ack" in message && message.ack && typeof message.ack === "object");
    const { ack } = message;
    assert.ok("highWaterMark" in ack && ack.highWaterMark && typeof ack.highWaterMark === "object");
    assert.ok("version" in ack.highWaterMark);
    assert.ok("outcome" in ack && ack.outcome && typeof ack.outcome === "object" && "case" in ack.outcome);
    assert.equal(ack.highWaterMark.version, version);
    assert.equal(ack.outcome.case, outcome);
  };
  const readChoices = async () => {
    const detail = await f.fetch(origin + route(f.owner));
    assert.equal(detail.status, 200);
    return (await detail.json()).settings.enabled_mcp_tools;
  };
  await expectAck(await toggle(id, 1n, choices(false)), 1n, "applied");
  assert.deepEqual(await readChoices(), { [search.enabled]: false });
  const other = "55555555-5555-4555-8555-555555555555";
  await expectAck(await toggle(other, 2n, choices(true)), 2n, "error");
  await expectAck(await toggle(id, 3n, { enabledMcpTools: { tools: { [search.approved]: true } } }), 3n, "error");
  assert.equal((await toggle(id, 4n, { ...choices(true), enabledWebSearch: true })).status, 400);
  assert.deepEqual(await readChoices(), { [search.enabled]: false });
  await expectAck(await toggle(id, 5n, choices(true)), 5n, "applied");
  assert.deepEqual(await readChoices(), { [search.enabled]: true });
  assert.deepEqual(f.store.settings.mcpServers.wiki, { url: server.url });
  assert.equal(f.sends.length, 0);
});

test("original Chat PUT and account PATCH commit independently and reopen with sparse preferences", async (t) => {
  const f = await fixture(t);
  const saved = await f.write("PUT", route(f.owner) + "?rendering_mode=raw", {
    settings: { enabled_mcp_tools: { [search.enabled]: false } },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual((await saved.json()).settings.enabled_mcp_tools, {
    [search.enabled]: false,
  });
  assert.deepEqual(f.store.settings.mcpServers.wiki, { url: server.url });
  const account = await f.write("PATCH", "/api/account/settings", {
    enabled_mcp_tools: { [read.enabled]: false },
  });
  assert.equal(account.status, 200, await account.clone().text());
  assert.equal(
    (await account.json()).settings.enabled_mcp_tools[read.enabled],
    false,
  );
  const detail = await f.fetch(origin + route(f.owner));
  assert.equal(detail.status, 200, await detail.clone().text());
  assert.deepEqual((await detail.json()).settings.enabled_mcp_tools, {
    [search.enabled]: false,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f046-reopen-"));
  const reopened = await CloudStore.open({
    root,
    userId: 1,
    transport: f.web,
    log() {},
  });
  t.after(async () => {
    await reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(reopened.conversation(id).connectorToolOverrides, {
    wiki: { search: false },
  });
  assert.deepEqual(reopened.settings.mcpServers.wiki, {
    url: server.url,
    disabled_tools: ["read"],
  });
});

test("queued assignments merge and a null only removes its own saved tool", async (t) => {
  const f = await fixture(t);
  const url = route(f.owner) + "?rendering_mode=raw";
  const write = (map: Record<string, boolean | null>) =>
    f.write("PUT", url, { settings: { enabled_mcp_tools: map } });
  const answers = await Promise.all([
    write({ [search.enabled]: false }),
    write({ [read.enabled]: true }),
  ]);
  for (const answer of answers)
    assert.equal(answer.status, 200, await answer.text());
  const clear = await write({ [search.enabled]: null });
  assert.equal(clear.status, 200, await clear.clone().text());
  assert.deepEqual((await clear.json()).settings.enabled_mcp_tools, {
    [read.enabled]: true,
  });
  assert.deepEqual(f.row.connectorToolOverrides, { wiki: { read: true } });
});

test("mixed bodies, forged grants, foreign orgs and retired leases leave the saved Chat untouched", async (t) => {
  const f = await fixture(t),
    other = await fixture(t, f.web, 2);
  const url = route(f.owner) + "?rendering_mode=raw";
  const payload = {
    settings: { enabled_mcp_tools: { [search.enabled]: false } },
  };
  assert.equal(
    (await f.write("PUT", url, { ...payload, name: "unrelated" })).status,
    400,
  );
  assert.equal(
    (
      await f.write("PUT", url, {
        settings: { enabled_mcp_tools: { [search.approved]: true } },
      })
    ).status,
    400,
  );
  assert.equal((await f.write("PUT", url + "&x=1", payload)).status, 501);
  assert.equal((await other.write("PUT", url, payload)).status, 404);
  const lease = (await f.cap()).activationLease;
  f.retire();
  const stale = await f.run({
    method: "PUT",
    path: url,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(payload)),
    capabilityLease: lease,
  });
  assert.equal(stale.status, 409);
  assert.equal(f.row.connectorToolOverrides, undefined);
  assert.equal(other.row.connectorToolOverrides, undefined);
});


test("Web reconnect verifies discovery before and after OAuth", async (t) => {
  const f = await fixture(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "f049-oauth-"));
  const tokens = new ConnectorTokens(profile);
  let available = true;
  let publicAccess = true;
  let rejectAfterExchange = false;
  let registrationFails = false;
  const oauthFetch: typeof fetch = async (input) => {
    const address = String(input);
    if (address.includes("oauth-protected-resource")) return Response.json({ resource: server.url, authorization_servers: ["https://auth.example"] });
    if (address.includes("oauth-authorization-server")) return Response.json({ issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register", code_challenge_methods_supported: ["S256"] });
    if (address.endsWith("/register")) return registrationFails ? new Response(null, { status: 503 }) : Response.json({ client_id: "client" });
    if (address.endsWith("/token")) {
      return Response.json({ access_token: "token", token_type: "Bearer" });
    }
    throw Error("Unexpected OAuth request");
  };
  const oauth = new ConnectorOAuth(profile, "https://test.example", oauthFetch, tokens, () => {}, () => true);
  t.after(() => { oauth.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const host = {
    getToken: () => tokens.get("wiki"),
    fetch: async (_input: unknown, init: RequestInit) => {
      if (!available) return new Response(null, { status: 500 });
      if (!publicAccess && (!tokens.get("wiki") || rejectAfterExchange)) return new Response(null, { status: 401 });
      const body = JSON.parse(String(init.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [] } });
    },
    beginLogin: (name: string, resource: string, callback: string) => oauth.begin(name, resource, callback),
    completeLogin: (state: string, code: string) => oauth.complete(state, code),
  };
  Object.assign(f.ctx, { connectors: host, runtime: { serviceUrl: "https://internal.example", publicUrl: origin } });
  Object.assign(f.ipcContext, { connectors: host });
  const capability = await f.cap();
  const base = `/api/organizations/${organizationUuid(f.owner)}/mcp`;
  const id = connectorUuid("wiki");
  const start = (query = "") => f.run({ method: "GET", path: `${base}/start-auth/${id}?response_format=json&claudex_return_url=https%3A%2F%2Ftest.example%2F${query}`, capabilityLease: capability.activationLease });
  const complete = (state: string, code: string) => f.run({ method: "POST", path: `${base}/complete-auth/${id}`, capabilityLease: capability.activationLease, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ state, code })) });
  const foreignOrigin = await f.run({ method: "GET", path: `${base}/start-auth/${id}?response_format=json&claudex_return_url=https%3A%2F%2Finternal.example%2F`, capabilityLease: capability.activationLease });
  assert.equal(foreignOrigin.status, 400);
  assert.deepEqual(JSON.parse(Buffer.from((await start()).body).toString()), { connected: true });
  assert.deepEqual(JSON.parse(Buffer.from((await start("&after_auth_rejection=true")).body).toString()), { connected: true });
  f.row.turns.push({ id: "protected-turn", prompt: "Call the tool", attachments: [], status: "completed", items: [protectedToolFailure], createdAt: 2 });
  const rejection = `&after_auth_rejection=true&conversation_uuid=${f.row.id}&tool_use_id=protected-turn:`;
  assert.equal((await start(rejection + "other-tool")).status, 404);
  assert.equal((await start("&after_auth_rejection=true&conversation_uuid=" + f.row.id)).status, 404);
  const registry = registryFor(path.resolve("build/official-ui"));
  const requestSchema = registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
  const responseSchema = registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineResponse")!;
  const payload = toBinary(requestSchema, deepCreate(requestSchema, { conversationId: f.row.id }));
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  const timeline = async () => {
    const response = await f.run({
      method: "POST", path: STREAM_TIMELINE_PATH, contentType: "application/connect+proto", body: frame,
    });
    assert.equal(response.status, 200);
    const update = fromBinary(responseSchema, response.body.subarray(5)) as any;
    assert.equal(update.event.event.case, "update");
    return update.event.event.value;
  };
  const challenged = await timeline();
  assert.equal(challenged.elicitations.length, 1);
  const [elicitation] = challenged.elicitations;
  assert.equal(elicitation.conversationId, f.row.id);
  assert.ok(challenged.contentBlocks.some((block: { id: string }) => block.id === elicitation.id));
  assert.deepEqual({
    kind: elicitation.request.kind,
    status: elicitation.request.status,
    originServerId: elicitation.request.originServerId,
    toolUseId: elicitation.request.toolUseId,
    holdsConversation: elicitation.request.holdsConversation,
  }, {
    kind: 6, status: 1, originServerId: id, toolUseId: "protected-turn:protected-call", holdsConversation: false,
  });
  const deferred = await start(rejection + "protected-call");
  assert.equal(deferred.status, 200);
  assert.ok(JSON.parse(Buffer.from(deferred.body).toString()).state);
  publicAccess = false;
  await f.mcpConfig.readCatalog("wiki");
  const inventory = await f.fetch(`https://test.example${base}/v2/bootstrap`);
  assert.equal(inventory.status, 200);
  assert.match(await inventory.text(), /"connected":false,"authStatus":"auth_required"/);
  const browserStart = await f.fetch(`https://test.example${base}/start-auth/${id}?redirect_url=%2Fcustomize&response_format=json&after_auth_rejection=true`);
  assert.equal(browserStart.status, 200);
  assert.ok((await browserStart.json()).state);
  const first = await start();
  assert.equal(first.status, 200);
  const state = JSON.parse(Buffer.from(first.body).toString()).state;
  assert.ok(state);
  assert.equal((await complete("bad", "code")).status, 503);
  const failedInventory = await f.fetch(`https://test.example${base}/v2/bootstrap`);
  assert.match(await failedInventory.text(), /"connected":false,"authStatus":"auth_required","usedAuthentication":false,"connectionError":"connection_failed"/);
  assert.equal((await complete(state, "code")).status, 200);
  assert.deepEqual((await timeline()).elicitations, []);
  assert.deepEqual(JSON.parse(Buffer.from((await start()).body).toString()), { connected: true });
  available = false;
  assert.equal((await start()).status, 503);
  available = true;
  tokens.set("wiki", undefined);
  const retry = JSON.parse(Buffer.from((await start()).body).toString()).state;
  rejectAfterExchange = true;
  assert.equal((await complete(retry, "code")).status, 503);
  const rejectedInventory = await f.fetch(`https://test.example${base}/v2/bootstrap`);
  assert.match(await rejectedInventory.text(), /"connected":false,"authStatus":"auth_required","usedAuthentication":false,"connectionError":"connection_failed"/);
  tokens.set("wiki", undefined);
  rejectAfterExchange = false;
  registrationFails = true;
  assert.equal((await start()).status, 503);
  const registrationInventory = await f.fetch(`https://test.example${base}/v2/bootstrap`);
  assert.match(await registrationInventory.text(), /"connected":false,"authStatus":"auth_required","usedAuthentication":false,"connectionError":"connection_failed"/);
});

test("original Web connector logout waits for revocation and preserves the saved connector and approvals", async (t) => {
  const f = await fixture(t);
  const config = { url: server.url, tools: { search: { approval_mode: "approve" } } };
  f.store.settings.mcpServers = { wiki: config, other: { url: "https://example.test/other" } };
  await f.store.sync();

  const tokens = new ConnectorTokens(f.store.root);
  const revokeRequests: URLSearchParams[] = [];
  let announceRevoke!: () => void;
  let finishRevoke!: () => void;
  const revokeStarted = new Promise<void>(resolve => { announceRevoke = resolve; });
  const revokeReleased = new Promise<void>(resolve => { finishRevoke = resolve; });
  let providerRefuses = true;
  let exchanges = 0;
  const provider: typeof fetch = async (request, init) => {
    const address = new URL(String(request));
    if (address.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: server.url, authorization_servers: ["https://auth.example"] });
    if (address.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return Response.json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        revocation_endpoint: "https://auth.example/revoke",
        code_challenge_methods_supported: ["S256"],
      });
    if (address.pathname === "/register") return Response.json({ client_id: "client" });
    if (address.pathname === "/token") {
      exchanges++;
      return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    }
    if (address.pathname === "/revoke") {
      revokeRequests.push(new URLSearchParams(String(init?.body)));
      if (providerRefuses) return new Response(null, { status: 503 });
      announceRevoke();
      await revokeReleased;
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected OAuth request " + address.pathname);
  };
  const oauth = new ConnectorOAuth(f.store.root, origin, provider, tokens, () => {}, () => true);
  t.after(() => { finishRevoke(); oauth.close(); });
  const host = {
    getToken: (name: string) => tokens.get(name),
    fetch: async (input: unknown, init: RequestInit) => {
      if (String(input) === server.url && !tokens.get("wiki"))
        return new Response(null, { status: 401 });
      const body = JSON.parse(String(init.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [] } });
    },
    beginLogin: (name: string, resource: string, callback: string) => oauth.begin(name, resource, callback),
    completeLogin: (state: string, code: string, issuer?: string, expectedName?: string) =>
      oauth.complete(state, code, issuer, expectedName),
  };
  Object.assign(f.ctx, { connectors: host, connectorOAuth: oauth, runtime: { serviceUrl: origin } });
  Object.assign(f.ipcContext, { connectors: host });

  const org = organizationUuid(f.owner);
  const wiki = connectorUuid("wiki");
  const other = connectorUuid("other");
  const base = `/api/organizations/${org}/mcp`;
  const pathToLogout = `${base}/logout/${wiki}`;
  const { activationLease } = await f.cap();
  const start = async () => {
    const response = await f.fetch(`${origin}${base}/start-auth/${wiki}?redirect_url=%2Fcustomize&response_format=json&after_auth_rejection=true`);
    assert.equal(response.status, 200);
    return (await response.json()).state;
  };
  const complete = (id: string, body: unknown) => f.run({ method: "POST", path: `${base}/complete-auth/${id}`,
    capabilityLease: activationLease, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) });
  const canceledState = await start();
  assert.equal((await complete(other, { state: canceledState, error: "access_denied" })).status, 404);
  assert.equal((await complete(wiki, { state: canceledState, error: "access_denied" })).status, 204);
  assert.equal((await complete(wiki, { state: canceledState, code: "code" })).status, 503);
  assert.equal(exchanges, 0);
  assert.deepEqual(f.store.settings.mcpServers.wiki, config);

  const state = await start();
  assert.equal((await complete(other, { state, code: "code" })).status, 503);
  assert.equal(exchanges, 0);
  assert.equal((await complete(wiki, { state, code: "code" })).status, 200);
  assert.equal(exchanges, 1);

  const logout = (url = pathToLogout, body?: string) => f.fetch(origin + url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  assert.equal((await f.fetch(origin + pathToLogout)).status, 501);
  assert.equal((await logout(pathToLogout + "?unknown=1")).status, 501);
  assert.equal((await logout(pathToLogout, "{}")).status, 400);
  assert.equal((await f.run({ method: "POST", path: pathToLogout, capabilityLease: activationLease, contentType: "application/json" })).status, 400);
  assert.equal((await logout(`${base}/logout/${other}`)).status, 409);
  assert.equal((await logout(pathToLogout.replace(org, organizationUuid("other-account")))).status, 404);
  assert.equal((await f.run({ method: "POST", path: pathToLogout })).status, 409);
  f.setPolicy({ ...openPolicy, connectors: [{ name: "other" }] });
  assert.equal((await logout()).status, 404);
  f.setPolicy(openPolicy);
  f.dispatcher.options.officialUiActions = false;
  await assert.rejects(
    f.run({ method: "POST", path: pathToLogout, capabilityLease: activationLease }),
    { code: webErrorCodes.methodUnavailable },
  );
  f.dispatcher.options.officialUiActions = true;
  assert.equal(revokeRequests.length, 0);

  const failed = await logout();
  assert.equal(failed.status, 503);
  assert.match(await failed.text(), /could not be revoked/);
  assert.equal(tokens.get("wiki"), "access");

  providerRefuses = false;
  let answered = false;
  const pendingLogout = logout().finally(() => { answered = true; });
  await Promise.race([revokeStarted, pendingLogout]);
  assert.equal(answered, false);
  assert.deepEqual(f.store.settings.mcpServers.wiki, config);
  finishRevoke();
  const response = await pendingLogout;
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(tokens.get("wiki"), undefined);
  assert.ok(revokeRequests.some(body => body.get("token") === "refresh"));
  assert.match(await (await f.fetch(origin + base + "/v2/bootstrap")).text(), /"connected":false,"authStatus":"auth_required"/);
  const status = await f.fetch(origin + base + "/remote_servers_with_connection");
  assert.equal(status.status, 200);
  const connections = await status.json();
  assert.equal(connections.find((connection: { uuid: string }) => connection.uuid === wiki)?.connection_state, "user_disconnected");
  assert.deepEqual(f.store.settings.mcpServers.wiki, config);
  assert.ok(await start());
  f.retire();
  assert.equal((await f.run({ method: "POST", path: pathToLogout, capabilityLease: activationLease })).status, 409);
});


test("original Web custom connector probes and saves through its account lease", async (t) => {
  const f = await fixture(t);
  const endpoint = "https://new-connector.example/mcp";
  const host = {
    async assertUrl(url: string) { assert.equal(url, endpoint); },
    async fetch(_input: unknown, init: RequestInit) {
      const body = JSON.parse(String(init.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : { tools: [{ name: "read", inputSchema: { type: "object" } }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
    setToken() {},
  };
  Object.assign(f.ctx, { connectors: host, handlers: new Map([["probeConnector", true], ["addCustomConnector", true]]), connectorTokens: { set() {} } });
  Object.assign(f.ipcContext, { connectors: host });
  const org = organizationUuid(f.owner);
  const base = `/api/organizations/${org}/mcp`;
  const post = (route: string, body: unknown) => f.fetch(origin + route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await post(base + "/probe", { url: endpoint });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"status":"detected"/);
  const body = { name: "New custom connector", url: endpoint,
    install: { type: "custom", posture: "no_auth", transport: "streamable-http", inputs: [] } };
  assert.equal((await post(base.replace(org, organizationUuid("other")) + "/remote_servers", body)).status, 404);
  const rejected = await fixture(t, memoryWebstore(), 3);
  Object.assign(rejected.ctx, { connectors: host, handlers: new Map([["probeConnector", true], ["addCustomConnector", true]]), connectorTokens: { set() {} } });
  Object.assign(rejected.ipcContext, { connectors: host });
  rejected.web.failNext("store.settings.put");
  const bad = await rejected.fetch(origin + `/api/organizations/${organizationUuid(rejected.owner)}/mcp/remote_servers`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(bad.status, 503);
  assert.equal(Object.hasOwn(rejected.store.settings.mcpServers, "New-custom-connector"), false);
  const saved = await post(base + "/remote_servers", body);
  const result = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(result));
  assert.equal(result.name, body.name);
  const reopened = await CloudStore.open({ root: f.store.root, userId: 1, transport: f.web, log() {} });
  try {
    assert.equal((reopened.settings.mcpServers["New-custom-connector"] as { url?: string }).url, endpoint);
  } finally {
    await reopened.close();
  }
});

test("Web refresh replaces the selected connector inventory and preserves authentication", async (t) => {
  const f = await fixture(t);
  const tokens = new ConnectorTokens(f.store.root);
  tokens.set("wiki", "test-token");
  const requests: string[] = [];
  let tools = ["old"];
  let available = true;
  let retire = false;
  const host = {
    getToken: (name: string) => tokens.get(name),
    async fetch(input: RequestInfo | URL, init: RequestInit) {
      const address = String(input);
      const rpc = JSON.parse(String(init.body));
      if (address === server.url) assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-token");
      if (!available) throw Error("private failure");
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") {
        requests.push(address);
        if (retire) f.retire();
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : { tools: (address === server.url ? tools : ["other"]).map((name) => ({ name, inputSchema: { type: "object" } })) } });
    },
  };
  f.store.settings.mcpServers = {
    wiki: { url: server.url, disabled_tools: ["old"] },
    other: { url: "https://other.example.test/mcp", disabled_tools: ["blocked"] },
  };
  Object.assign(f.ctx, { connectors: host });
  Object.assign(f.ipcContext, { connectors: host });
  const org = organizationUuid(f.owner);
  const base = `/api/organizations/${org}/mcp/remote_servers`;
  const refresh = base + "/" + connectorUuid("wiki") + "/clear_cache";
  const inventory = async (name = "wiki") => {
    const response = await f.fetch(origin + base + "_with_connection");
    assert.equal(response.status, 200);
    const rows: Array<{ uuid: string; tools: Array<{ name: string }> }> = await response.json();
    return rows.find((row) => row.uuid === connectorUuid(name))?.tools.map((tool) => tool.name);
  };
  assert.deepEqual(await inventory(), ["old"]);
  tools = ["fresh"];
  assert.deepEqual(await inventory(), ["old"]);
  const cap = await f.cap();
  assert.equal((await f.run({ method: "POST", path: refresh })).status, 409);
  assert.equal((await f.run({ method: "POST", path: refresh.replace(org, organizationUuid("other")), capabilityLease: cap.activationLease })).status, 404);
  assert.equal((await f.fetch(origin + refresh + "?target=other", { method: "POST" })).status, 501);
  assert.equal((await f.fetch(origin + refresh, { method: "POST", body: "{}" })).status, 400);
  assert.equal((await f.fetch(origin + refresh.replace(connectorUuid("wiki"), connectorUuid("absent")), { method: "POST" })).status, 404);
  assert.equal((await f.fetch(origin + refresh, { method: "POST" })).status, 204);
  assert.deepEqual(await inventory(), ["fresh"]);
  assert.deepEqual(await inventory("other"), ["other", "blocked"]);
  assert.equal(requests.filter((address) => address === server.url).length, 2);
  assert.equal(requests.filter((address) => address !== server.url).length, 1);
  assert.equal(tokens.get("wiki"), "test-token");
  available = false;
  const failure = await f.fetch(origin + refresh, { method: "POST" });
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private failure|test-token/);
  available = true;
  retire = true;
  assert.equal((await f.fetch(origin + refresh, { method: "POST" })).status, 409);
  assert.equal(tokens.get("wiki"), "test-token");
});

test("Web deletion waits for persisted removal before forgetting connector credentials", async (t) => {
  const web = memoryWebstore();
  const f = await fixture(t, web);
  f.store.settings.mcpServers = { wiki: { url: server.url }, other: { url: "https://other.example.test/mcp" } };
  await f.store.sync();
  const tokens = new ConnectorTokens(f.store.root);
  tokens.set("wiki", "test-token");
  tokens.set("other", "other-token");
  const clients = new ConnectorClients(f.store.root);
  clients.set("wiki", { clientId: "test-client" }, server.url);
  const host = { setToken: (name: string, token?: string) => tokens.set(name, token) };
  Object.assign(f.ctx, { connectors: host, connectorTokens: tokens });
  Object.assign(f.ipcContext, { connectors: host });
  const base = `/api/organizations/${organizationUuid(f.owner)}/mcp/remote_servers`;
  const target = base + "/" + connectorUuid("wiki");
  const otherTarget = base + "/" + connectorUuid("other");
  const remove = (url: string) => f.fetch(origin + url, { method: "DELETE" });
  const request = web.request.bind(web);
  let acknowledge!: () => void, entered!: () => void;
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  const confirmation = new Promise<void>((resolve) => { acknowledge = resolve; });
  web.request = async (op, userId, body) => {
    if (op === "store.settings.put" && !Object.hasOwn(body.settings.mcpServers, "wiki")) {
      entered();
      await confirmation;
    }
    return request(op, userId, body);
  };
  const removal = remove(target);
  await saving;
  assert.equal(tokens.get("wiki"), "test-token");
  assert.equal(clients.get("wiki", server.url)?.clientId, "test-client");
  assert.ok(Object.hasOwn(f.store.settings.mcpServers, "wiki"));
  acknowledge();
  assert.equal((await removal).status, 204);
  assert.equal(tokens.get("wiki"), undefined);
  assert.equal(new ConnectorClients(f.store.root).get("wiki", server.url), undefined);
  assert.equal(tokens.get("other"), "other-token");
  assert.equal((await remove(target)).status, 404);
  const reopened = await CloudStore.open({ root: f.store.root, userId: 1, transport: web, log() {} });
  try {
    assert.deepEqual(Object.keys(reopened.settings.mcpServers), ["other"]);
  } finally {
    await reopened.close();
  }
  web.failNext("store.settings.put");
  assert.equal((await remove(otherTarget)).status, 503);
  assert.equal(tokens.get("other"), "other-token");
  assert.ok(Object.hasOwn(f.store.settings.mcpServers, "other"));
});
