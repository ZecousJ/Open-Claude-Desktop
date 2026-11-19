import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { openPolicy } from "../../shared/client-policy";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { collectOfficialResponse } from "../../shared/web-client/official-response";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import { useElectronShim } from "./runner-core-support.test";

useElectronShim();

const { officialUiRead } = await import("../../runner/src/official-ui-read");
const { connectorUuid } =
  await import("../../electron/official-ui/api/connector-auth");
const { organizationUuid } =
  await import("../../electron/official-ui/api/context");
const { createOfficialReadFetch } =
  await import("../../src-web/official/read-fetch");
const { negotiatedOfficialAction } =
  await import("../../src-web/official/negotiated-action");
const { McpAppToolbox } =
  await import("../../electron/official-ui/api/mcp-app-toolbox");

test("the Web toolbox uses the registered MCP connector session for real Apps", async (t) => {
  const calls: string[] = [];
  const fixtureSession = "fixture-session";
  const uri = "ui://notes/view.html";
  const tool = {
    name: "show_notes",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: uri } },
  };
  const actuate = {
    name: "add_note",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["app"] } },
  };
  const modelOnly = {
    name: "model_only",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["model"] } },
  };
  const blocked = { name: "blocked", inputSchema: { type: "object" } };
  const ask = { name: "ask", inputSchema: { type: "object" } };
  const resource = {
    uri,
    text: "<html><p>Notes</p></html>",
    mimeType: "text/html;profile=mcp-app",
    _meta: { ui: { prefersBorder: true } },
  };
  const notes: string[] = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, "/mcp");
    assert.equal(req.headers.authorization, "Bearer saved-token");
    if (req.method === "DELETE") {
      assert.equal(req.headers["mcp-session-id"], fixtureSession);
      calls.push("DELETE");
      res.writeHead(204).end();
      return;
    }
    assert.equal(req.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(method);
    let result: unknown;
    if (method === "initialize") {
      assert.equal(req.headers["mcp-session-id"], undefined);
      assert.deepEqual(params.capabilities, {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      });
      res.setHeader("Mcp-Session-Id", fixtureSession);
      result = {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "Notes", version: "1" },
        capabilities: { tools: {}, resources: {} },
      };
    } else {
      assert.equal(req.headers["mcp-session-id"], fixtureSession);
      assert.equal(req.headers["mcp-protocol-version"], "2025-03-26");
      switch (method) {
        case "notifications/initialized":
          res.writeHead(202).end();
          return;
        case "tools/list":
          result =
            params.cursor === "next"
              ? { tools: [tool, actuate, modelOnly, blocked, ask] }
              : { tools: [], nextCursor: "next" };
          break;
        case "resources/list":
          result = {
            resources: [
              { uri, name: "App", mimeType: resource.mimeType },
              { uri: "ui://notes/private.html", name: "Private" },
            ],
          };
          break;
        case "resources/read":
          assert.equal(params.uri, uri);
          result = { contents: [resource] };
          break;
        case "tools/call":
          assert.equal(params.name, actuate.name);
          if (params.arguments?.note === "denied") {
            res.writeHead(200, { "Content-Type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32010,
                  message: "The notes deck is closed.",
                  data: { reopen: true },
                },
              }),
            );
            return;
          }
          notes.push(params.arguments.note);
          result = {
            content: [{ type: "text", text: notes.at(-1) }],
            structuredContent: { notes: [...notes] },
            _meta: { source: "notes" },
          };
          res
            .writeHead(200, { "Content-Type": "text/event-stream" })
            .end(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`,
            );
          return;
        default:
          assert.fail(`Unexpected upstream method ${method}`);
      }
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const config = {
    url,
    disabled_tools: [blocked.name],
    tools: {
      [actuate.name]: { approval_mode: "approve" },
      [modelOnly.name]: { approval_mode: "approve" },
      [blocked.name]: { approval_mode: "approve" },
      removed_tool: { approval_mode: "approve" },
    },
  };
  const root = t.name;
  let activation = {};
  let token = "saved-token";
  const retirement = new Set<() => void>();
  const ctx = {
    userId: 443,
    activeAccount: { id: "owned-account" },
    store: { root, settings: { mcpServers: { notes: config } } },
    connectors: { fetch: globalThis.fetch, getToken: () => token },
    officialSessionIdentity: () => activation,
    setAccessToken() {},
    policy: () => openPolicy,
    onAccountDeactivating(callback: () => void) {
      retirement.add(callback);
      return () => retirement.delete(callback);
    },
  };
  const dispatcher = {
    options: { officialUiRoot: root, officialUiActions: true },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
  } as unknown as Parameters<typeof officialUiRead>[0];
  const dispatch =
    (method: "officialUiRead" | "officialUiAction") =>
    async (request: OfficialUiReadRequest) => {
      const args = [encodeWireValue(request)];
      const answer = await officialUiRead(dispatcher, {
        t: "call",
        id: "request",
        deadlineMs: Date.now() + 30_000,
        user: { id: ctx.userId, accessToken: "account-token" },
        method,
        args,
      });
      const wire = decodeWireValue(encodeWireValue(answer));
      return collectOfficialResponse({
        initial: wire,
        allowTransfer: false,
        isCurrent: () => true,
        readChunk: async () => assert.fail(),
      });
    };
  const read = dispatch("officialUiRead");
  const action = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: String(ctx.userId),
    isCurrent: () => true,
    read,
    action: dispatch("officialUiAction"),
  });
  const appFetch = createOfficialReadFetch(
    "https://claudex.example",
    read,
    async () => assert.fail("Toolbox escaped the Web bridge"),
    undefined,
    action,
  );
  const path = `/v1/toolbox/shttp/mcp/${connectorUuid("notes")}`;
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-organization-uuid": organizationUuid(ctx.activeAccount.id),
    "x-mcp-client-session-id": "renderer-client",
  });
  const rpc = (
    method: string,
    params?: object,
    id: string | number | undefined = "message",
    target = path,
    requestHeaders = headers,
  ) =>
    appFetch(target, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  const initialize = () =>
    rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
      },
      7,
    );

  assert.equal((await appFetch(path)).status, 405);
  assert.equal(
    (
      await rpc(
        "initialize",
        {},
        7,
        `/v1/toolbox/shttp/mcp/${connectorUuid("missing")}`,
      )
    ).status,
    404,
  );
  const wrongOrg = new Headers(headers);
  wrongOrg.set("x-organization-uuid", organizationUuid("another-account"));
  assert.equal((await rpc("initialize", {}, 7, path, wrongOrg)).status, 404);
  assert.deepEqual(calls, []);
  assert.equal(
    (await (await rpc("server/discover")).json()).error.code,
    -32601,
  );

  const initialized = await initialize();
  assert.equal(initialized.status, 200);
  const mcpId = initialized.headers.get("Mcp-Session-Id");
  assert(mcpId);
  assert.notEqual(mcpId, fixtureSession);
  headers.set("Mcp-Session-Id", mcpId);
  headers.set("MCP-Protocol-Version", "2025-03-26");
  assert.equal((await initialized.json()).result.serverInfo.name, "Notes");
  assert.equal(
    (
      await appFetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      })
    ).status,
    202,
  );
  assert.equal(
    (await (await rpc("tools/list")).json()).result.nextCursor,
    "next",
  );
  assert.deepEqual(
    (await (await rpc("tools/list", { cursor: "next" })).json()).result.tools,
    [tool, actuate, modelOnly, ask],
  );
  assert.deepEqual(
    (await (await rpc("resources/list")).json()).result.resources.map(
      (item: { uri: string }) => item.uri,
    ),
    [uri],
  );
  assert.deepEqual(await (await rpc("resources/read", { uri }, 101)).json(), {
    jsonrpc: "2.0",
    id: 101,
    result: { contents: [resource] },
  });
  assert.equal(
    (
      await (
        await rpc("resources/read", { uri: "ui://notes/private.html" })
      ).json()
    ).error.code,
    -32002,
  );
  assert.equal(calls.filter((method) => method === "resources/read").length, 1);

  const wrongClient = new Headers(headers);
  wrongClient.set("x-mcp-client-session-id", "different-client");
  assert.equal(
    (
      await rpc(
        "tools/call",
        { name: actuate.name },
        "different",
        path,
        wrongClient,
      )
    ).status,
    404,
  );
  for (const name of [modelOnly.name, blocked.name, ask.name, "removed_tool"])
    assert((await (await rpc("tools/call", { name })).json()).error);
  assert.equal(calls.filter((method) => method === "tools/call").length, 0);
  const added = await (
    await rpc("tools/call", {
      name: actuate.name,
      arguments: { note: "first" },
    })
  ).json();
  assert.deepEqual(added, {
    jsonrpc: "2.0",
    id: "message",
    result: {
      content: [{ type: "text", text: "first" }],
      structuredContent: { notes: ["first"] },
      _meta: { source: "notes" },
    },
  });
  assert.deepEqual(
    (
      await (
        await rpc(
          "tools/call",
          { name: actuate.name, arguments: { note: "denied" } },
          102,
        )
      ).json()
    ).error,
    {
      code: -32010,
      message: "The notes deck is closed.",
      data: { reopen: true },
    },
  );
  assert.deepEqual(
    calls.filter((method) => method === "initialize"),
    ["initialize"],
  );

  assert.equal(
    (await appFetch(path, { method: "DELETE", headers })).status,
    204,
  );
  assert.equal((await rpc("ping")).status, 404);
  headers.delete("Mcp-Session-Id");
  const next = await initialize();
  const nextId = next.headers.get("Mcp-Session-Id");
  assert(nextId);
  headers.set("Mcp-Session-Id", nextId);
  token = "replacement";
  assert.equal((await rpc("ping")).status, 404);
  assert.equal(calls.filter((method) => method === "DELETE").length, 1);
  activation = {};
  for (const close of retirement) close();
  assert.equal((await rpc("ping")).status, 404);
});

test("App callbacks obey the originating Code session's current connector settings", async (t) => {
  const toolbox = new McpAppToolbox();
  const accountId = "owned-account";
  const serverName = "notes";
  const connectorId = connectorUuid(serverName);
  const toolName = "add_note";
  const first = { sessionId: "local_first", toolUseId: "tool-first" };
  const second = { sessionId: "local_second", toolUseId: "tool-second" };
  let allowed = first;
  let duringDiscovery: (() => void) | undefined;
  const requests: { method: string; params?: object }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ method, params });
    if (method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result =
      method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            serverInfo: { name: serverName, version: "1" },
            capabilities: { tools: {} },
          }
        : method === "tools/list"
          ? {
              tools: [
                { name: toolName, _meta: { ui: { visibility: ["app"] } } },
              ],
            }
          : { content: [{ type: "text", text: "added" }] };
    if (method === "tools/list") duringDiscovery?.();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const settings = {
    mcpServers: {
      [serverName]: {
        url: `http://127.0.0.1:${address.port}/mcp`,
        tools: { [toolName]: { approval_mode: "approve" } },
      },
    },
  };
  const host = {
    activation: {},
    current: () => true,
    settings: () => settings,
    policy: () => openPolicy,
    fetch: globalThis.fetch,
    headers: () => undefined,
    async codeScope(
      scope: typeof first,
      target: { serverName: string; toolName: string },
    ) {
      return (
        scope.sessionId === allowed.sessionId &&
        scope.toolUseId === allowed.toolUseId &&
        target.serverName === serverName &&
        target.toolName === toolName
      );
    },
  };
  const headers = {
    organizationId: organizationUuid(accountId),
    clientSessionId: "renderer-client",
    sessionId: undefined as string | undefined,
  };
  const rpc = (method: string, params?: object, id?: number) =>
    toolbox.handle({
      accountId,
      connectorId,
      headers,
      method: "POST",
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
      host,
    });
  const created = await rpc("initialize", { protocolVersion: "2025-03-26" }, 1);
  assert(created.mcpSessionId);
  headers.sessionId = created.mcpSessionId;
  t.after(() =>
    toolbox.handle({ accountId, connectorId, headers, method: "DELETE", host }),
  );
  await rpc("notifications/initialized");
  const call = async (scope: unknown) => {
    const answer = await rpc(
      "tools/call",
      {
        name: toolName,
        _meta: { claudex_code_scope: scope, progressToken: 42 },
      },
      2,
    );
    return JSON.parse(Buffer.from(answer.body).toString());
  };

  const beforeDenial = requests.length;
  assert.equal((await call(second)).error?.code, -32000);
  assert.equal((await call(null)).error?.code, -32602);
  assert.equal(requests.length, beforeDenial);

  assert.deepEqual((await call(first)).result, {
    content: [{ type: "text", text: "added" }],
  });
  assert.deepEqual(requests.at(-1), {
    method: "tools/call",
    params: { name: toolName, _meta: { progressToken: 42 } },
  });

  duringDiscovery = () => {
    allowed = second;
  };
  assert.equal((await call(first)).error?.code, -32000);
  duringDiscovery = undefined;
  assert.equal((await call(first)).error?.code, -32000);
  assert.equal(
    requests.filter(({ method }) => method === "tools/call").length,
    1,
  );
  assert.deepEqual((await call(second)).result, {
    content: [{ type: "text", text: "added" }],
  });
});
