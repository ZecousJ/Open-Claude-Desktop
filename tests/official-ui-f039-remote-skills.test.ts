import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openPolicy } from "../shared/client-policy";
import type { Conversation } from "../shared/types";
import type { McpServerState } from "../shared/settings-desktop-api";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { Store } from "../electron/store/store";
import { useElectronShim } from "./runner/runner-core-support.test";

useElectronShim();
const { RemoteConnectorSkills } =
  await import("../electron/connectors/remote-skills");
const { connectorUuid, connectorsRoute } =
  await import("../electron/official-ui/api/connectors");
const { organizationUuid } =
  await import("../electron/official-ui/api/context");

const extension = "io.modelcontextprotocol/skills";
const index = "skill://index.json";
const uri = "example://test/report/SKILL.md";
const text =
  "---\nname: report\ndescription: Generate a report\n---\nSummarize the audit results.";
const entry = {
  frontmatter: { name: "report", description: "Generate a report" },
  url: uri,
  digest: "sha256:" + "a".repeat(64),
};

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  let current = true;
  let token = "test-token";
  let capabilities: Record<string, unknown> = {
    resources: {},
    extensions: { [extension]: {} },
  };
  let entries = [entry];
  let body = { uri, text };
  let beforeResource = (_uri: string) => {};
  let failBody = false;
  const calls: { method: string; uri?: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "DELETE") {
      calls.push({ method: "DELETE" });
      res.writeHead(204).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { id, method, params } = JSON.parse(raw);
    calls.push({ method, ...(params?.uri ? { uri: params.uri } : {}) });
    if (method === "notifications/initialized") {
      assert.equal(req.headers["mcp-session-id"], "connector-skill-session");
      res.writeHead(202).end();
      return;
    }
    let result;
    if (method === "initialize") {
      assert.deepEqual(params.capabilities, {
        extensions: { [extension]: {} },
      });
      result = { protocolVersion: "2025-03-26", capabilities };
    } else {
      assert.equal(method, "resources/read");
      assert.equal(req.headers["mcp-session-id"], "connector-skill-session");
      beforeResource(params.uri);
      if (params.uri !== index && failBody) {
        res.writeHead(400).end();
        return;
      }
      result = {
        contents: [
          params.uri === index
            ? { uri: index, text: JSON.stringify({ skills: entries }) }
            : body,
        ],
      };
    }
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "connector-skill-session",
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  store.settings.mcpServers = { wiki: { url } };
  let policy = openPolicy;
  const catalog = new RemoteConnectorSkills({
    store,
    current: () => current,
    policy: () => policy,
    headers: () => ({ Authorization: `Bearer ${token}` }),
  });
  const conversation: Conversation = {
    id: "session",
    title: "Connector skill",
    mode: "chat",
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
  };
  const skill = {
    connectorId: connectorUuid("wiki"),
    name: "report",
    conversation,
    current: () => true,
  };
  const state: McpServerState = {
    name: "wiki",
    url,
    state: "ready",
    tools: 0,
    authStatus: "bearerToken",
  };
  return {
    url,
    calls,
    catalog,
    skill,
    state,
    store,
    beforeResource(fn: typeof beforeResource) {
      beforeResource = fn;
    },
    setEntries(value: typeof entries) {
      entries = value;
    },
    setBody(value: typeof body) {
      body = value;
    },
    failBodyRead() {
      failBody = true;
    },
    setCapabilities(value: typeof capabilities) {
      capabilities = value;
    },
    changeAccount() {
      current = false;
    },
    signOutConnector() {
      token = "";
    },
    blockConnector() {
      policy = { ...openPolicy, connectors: [] };
    },
  };
}

test("bootstrap reads only the advertised MCP skill index and emits the original skill event", async (t) => {
  const f = await fixture(t);
  const owner = "fixture-owner";
  const ctx: AdapterContext = {
    root: f.store.root,
    account: () => ({ id: owner, email: "owner@example.test", name: "Owner" }),
    settings: () => f.store.settings,
    call: async () => ({ servers: [f.state] }),
    listConversations: async () => [],
    loadConversation: async () => undefined,
    onEvent: () => () => {},
    modelCatalog: async () => null,
    snapshot: async () =>
      assert.fail("Connector discovery does not need a snapshot."),
    appVersion: "fixture",
    log: () => {},
    remoteConnectorSkills: () => f.catalog,
  };
  const server = createServer((req, res) => {
    void connectorsRoute(req, res, req.url ?? "", ctx);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bootstrap = `http://127.0.0.1:${address.port}/api/organizations/${organizationUuid(owner)}/mcp/v2/bootstrap`;
  const response = await fetch(bootstrap);
  assert.equal(response.status, 200);
  const stream = await response.text();
  const row = /^event: skills\ndata: (.+)$/m.exec(stream);
  assert.ok(row);
  assert.deepEqual(JSON.parse(row[1]), {
    server_uuid: f.skill.connectorId,
    skills: [entry],
  });
  assert.doesNotMatch(stream, /Summarize the audit results|test-token/);
  assert.deepEqual(
    f.calls.filter((call) => call.uri).map((call) => call.uri),
    [index],
  );
  f.setCapabilities({ tools: {} });
  const refreshed = await fetch(bootstrap);
  const withdrawn = /^event: skills\ndata: (.+)$/m.exec(await refreshed.text());
  assert.ok(withdrawn);
  assert.deepEqual(JSON.parse(withdrawn[1]), {
    server_uuid: f.skill.connectorId,
    skills: [],
  });
  assert.deepEqual(
    f.calls.filter((call) => call.uri).map((call) => call.uri),
    [index],
  );
});

test("selected connector skill resolves the body from the same authorized MCP session", async (t) => {
  const f = await fixture(t);
  const result = await f.catalog.resolve(f.skill);
  assert.equal(result.text, text);
  assert.ok(result.resource);
  assert.ok(result.connection);
  result.validate();
  assert.deepEqual(f.calls, [
    { method: "initialize" },
    { method: "notifications/initialized" },
    { method: "resources/read", uri: index },
    { method: "resources/read", uri },
    { method: "DELETE" },
  ]);
  f.signOutConnector();
  assert.throws(result.validate, /connector or account changed/);
});

test("retry refuses endpoint and advertised URI changes before requesting their content", async (t) => {
  const f = await fixture(t);
  const { connection, resource } = await f.catalog.resolve(f.skill);
  const expected = { resource, connection };
  f.calls.length = 0;
  f.store.settings.mcpServers = { wiki: { url: f.url + "?changed=true" } };
  await assert.rejects(
    f.catalog.resolve({ ...f.skill, expected }),
    /connector or account changed/,
  );
  assert.equal(f.calls.length, 0);
  f.store.settings.mcpServers = { wiki: { url: f.url } };
  f.setEntries([{ ...entry, url: "example://different/report/SKILL.md" }]);
  await assert.rejects(
    f.catalog.resolve({ ...f.skill, expected }),
    /connector or account changed/,
  );
  assert.deepEqual(
    f.calls.filter((call) => call.uri).map((call) => call.uri),
    [index],
  );
});

test("ambiguous, unauthorized and unsupported sources do not expose invocable skill content", async (t) => {
  const f = await fixture(t);
  f.setCapabilities({ resources: {} });
  assert.deepEqual((await f.catalog.list([f.state])).get("wiki"), []);
  await assert.rejects(f.catalog.resolve(f.skill), /skill is unavailable/);
  assert.equal(
    f.calls.some((call) => call.uri),
    false,
  );
  f.setCapabilities({ resources: {}, extensions: { [extension]: {} } });
  f.setEntries([entry, { ...entry, url: "example://other/report/SKILL.md" }]);
  assert.deepEqual((await f.catalog.list([f.state])).get("wiki"), []);
  await assert.rejects(f.catalog.resolve(f.skill), /skill is unavailable/);
  const discovered = f.calls.length;
  f.skill.conversation.connectorOverrides = { wiki: false };
  await assert.rejects(
    f.catalog.resolve(f.skill),
    /connector or account changed/,
  );
  f.skill.conversation.connectorOverrides = undefined;
  f.store.settings.mcpServers = { wiki: { url: f.url, enabled: false } };
  assert.equal((await f.catalog.list([f.state])).size, 0);
  await assert.rejects(
    f.catalog.resolve(f.skill),
    /connector or account changed/,
  );
  f.store.settings.mcpServers = { wiki: { url: f.url } };
  f.blockConnector();
  assert.equal((await f.catalog.list([f.state])).size, 0);
  assert.equal(f.calls.length, discovered);
});

test("a resource mismatch or an account change never hands connector markdown to the caller", async (t) => {
  const f = await fixture(t);
  f.setBody({ uri: "example://different/report/SKILL.md", text });
  await assert.rejects(f.catalog.resolve(f.skill), /skill is unavailable/);
  f.setBody({ uri, text: text.replace("name: report", "name: different") });
  await assert.rejects(f.catalog.resolve(f.skill), /skill is unavailable/);
  f.beforeResource((uri) => {
    if (uri === index) f.changeAccount();
  });
  const started = f.calls.length;
  await assert.rejects(
    f.catalog.resolve(f.skill),
    /connector or account changed/,
  );
  assert.deepEqual(
    f.calls
      .slice(started)
      .filter((call) => call.uri)
      .map((call) => call.uri),
    [index],
  );
});

test("an MCP HTTP 400 on the selected body leaves its index visible and refuses invocation", async (t) => {
  const f = await fixture(t);
  f.failBodyRead();
  assert.deepEqual((await f.catalog.list([f.state])).get("wiki"), [entry]);
  await assert.rejects(f.catalog.resolve(f.skill), /skill is unavailable/);
  assert.deepEqual(
    f.calls.filter((call) => call.uri).map((call) => call.uri),
    [index, index, uri],
  );
});
