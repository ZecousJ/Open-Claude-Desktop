import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openPolicy } from "../shared/client-policy";
import { recordConnectorAuthRejection } from "../electron/connectors/connector-auth-rejection";
import { Store } from "../electron/store/store";
import { ConnectorClients } from "../electron/connectors/connector-clients";
import { useElectronShim } from "./runner/runner-core-support.test";

useElectronShim();
const { WebConnectorCatalog } = await import("../runner/src/connector-catalog");

const url = "https://wiki.example.test/mcp";
const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  ...(name === "old_tool" && {
    _meta: {
      ui: { resourceUri: "ui://wiki/view.html", visibility: ["app", "model"] },
      "wiki/private": "internal value",
    },
  }),
  ...(name === "page_two" && { _meta: { ui: { visibility: ["app"] } } }),
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const config = { wiki: { url } };
  store.settings.mcpServers = config;
  let identity = {};
  let auth = false;
  let toolName = "old_tool";
  const calls: string[] = [];
  let token: string | undefined;
  let accepts = (_headers: Headers) => true;
  const headers: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), config.wiki.url);
    const sent = new Headers(init?.headers);
    headers.push(sent);
    if (auth || !accepts(sent)) return new Response(null, { status: 401 });
    const body = JSON.parse(String(init?.body));
    calls.push(body.method);
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (body.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-03-26" },
      });
    assert.equal(body.method, "tools/list");
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: body.params.cursor
        ? { tools: [tool("page_two")], nextCursor: null }
        : { tools: [tool(toolName)], nextCursor: "two" },
    });
  };
  const ctx = {
    store,
    officialSessionIdentity: () => identity,
    closed: false,
    policy: () => openPolicy,
    connectors: { fetch, getToken: () => token },
  };
  return {
    catalog: new WebConnectorCatalog(ctx as never),
    store,
    config,
    calls,
    headers,
    setToken(value: string | undefined) {
      token = value;
    },
    requireHeaders(match: (headers: Headers) => boolean) {
      accepts = match;
    },
    changeAccount() {
      identity = {};
      toolName = "new_tool";
    },
    requireAuth() {
      auth = true;
    },
  };
}

test("a cold Web account discovers actual paginated remote tools and retains disabled definitions", async (t) => {
  const f = fixture(t);
  const a = await f.catalog.read();
  assert.equal(a.servers[0].state, "ready");
  assert.deepEqual(
    a.servers[0].toolList?.map((t) => t.name),
    ["old_tool", "page_two"],
  );
  Object.assign(f.config.wiki, {
    disabled_tools: ["old_tool"],
  });
  const b = await f.catalog.read();
  const disabled = b.servers[0].toolList?.find((t) => t.name === "old_tool");
  assert.equal(disabled?.enabled, false);
  assert.deepEqual(disabled?.definition?.inputSchema, { type: "object" });
  assert.deepEqual(disabled?.definition?._meta, {
    ui: { resourceUri: "ui://wiki/view.html", visibility: ["app", "model"] },
  });
  assert.deepEqual(b.servers[0].toolList?.[1].definition?._meta, {
    ui: { visibility: ["app"] },
  });
  assert.deepEqual(f.calls, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/list",
  ]);
});

test("retiring an account discards its cached tool definitions", async (t) => {
  const f = fixture(t);
  await f.catalog.read();
  f.changeAccount();
  const result = await f.catalog.read();
  assert.deepEqual(
    result.servers[0].toolList?.map((t) => t.name),
    ["new_tool", "page_two"],
  );
});

test("an authenticated catalogue refusal is shown as needing sign-in", async (t) => {
  const f = fixture(t);
  f.requireAuth();
  const result = await f.catalog.read();
  assert.equal(result.servers[0].authStatus, "notLoggedIn");
  assert.deepEqual(result.servers[0].toolList, []);
});

test("refreshing a connector checks the remote server instead of its cached inventory", async (t) => {
  const f = fixture(t);
  await f.catalog.read();
  f.requireAuth();
  const result = await f.catalog.read("wiki");
  assert.equal(result.servers[0].authStatus, "notLoggedIn");
});

test("catalog authenticates with stored request headers only at the installed URL", async (t) => {
  const f = fixture(t);
  new ConnectorClients(f.store.root).set(
    "wiki",
    {
      headers: {
        authorization: "Token static-secret",
        "x-tenant-id": "tenant",
      },
      staticAuth: true,
    },
    url,
  );
  f.requireHeaders(
    (headers) =>
      headers.get("authorization") === "Token static-secret" &&
      headers.get("x-tenant-id") === "tenant",
  );
  const result = await f.catalog.read();
  assert.equal(result.servers[0].authStatus, "staticHeaders");
  assert.equal(result.servers[0].state, "ready");
  assert.equal(result.servers[0].tools, 2);
  assert.doesNotMatch(JSON.stringify(result), /static-secret|x-tenant-id/);
  f.requireAuth();
  const rejected = await f.catalog.read("wiki");
  assert.equal(rejected.servers[0].state, "failed");
  assert.notEqual(rejected.servers[0].authStatus, "notLoggedIn");
  f.config.wiki.url = "https://elsewhere.example.test/mcp";
  await f.catalog.read();
  assert.equal(f.headers.at(-1)?.get("authorization"), null);
  assert.equal(f.headers.at(-1)?.get("x-tenant-id"), null);
});

test("catalog waits for required OAuth and then combines its bearer token with request headers", async (t) => {
  const f = fixture(t);
  new ConnectorClients(f.store.root).set(
    "wiki",
    {
      headers: { "x-api-key": "gateway-secret" },
      oauth: { registration: "dcr", posture: "auth_required" },
    },
    url,
  );
  f.requireHeaders(
    (headers) =>
      headers.get("authorization") === "Bearer oauth-token" &&
      headers.get("x-api-key") === "gateway-secret",
  );
  const waiting = await f.catalog.read();
  assert.equal(waiting.servers[0].authStatus, "notLoggedIn");
  assert.equal(f.headers.length, 0);
  f.setToken("oauth-token");
  const ready = await f.catalog.read();
  assert.equal(ready.servers[0].authStatus, "bearerToken");
  assert.equal(ready.servers[0].tools, 2);
  assert.doesNotMatch(JSON.stringify(ready), /oauth-token|gateway-secret/);
});

test("anonymous catalog keeps tools available when a protected call requires OAuth", async (t) => {
  const f = fixture(t);
  const clients = new ConnectorClients(f.store.root);
  clients.set("wiki", { oauth: { posture: "defer_auth" } }, url);
  assert.equal((await f.catalog.read()).servers[0].authStatus, "unsupported");
  recordConnectorAuthRejection(f.store, "wiki", url);
  const challenged = (await f.catalog.read()).servers[0];
  assert.equal(challenged.authStatus, "notLoggedIn");
  assert.equal(challenged.tools, 2);
  f.setToken("accepted");
  assert.equal((await f.catalog.read()).servers[0].authStatus, "bearerToken");
  f.setToken(undefined);
  assert.equal((await f.catalog.read()).servers[0].authStatus, "unsupported");
  recordConnectorAuthRejection(f.store, "wiki", url);
  f.config.wiki.url = "https://wiki.example.test/other";
  assert.equal((await f.catalog.read()).servers[0].authStatus, "unsupported");
});
