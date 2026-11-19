/** Pure mocked connector calls and in-memory HTTP streams; no connector/network/config activity. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { protectedToolFailure } from "./support/f040-auth-rejection";
import { ConnectorProbeError } from "../electron/connectors/connector-probe";
import { ConnectorAddressError } from "../runner/src/connectors";
import {
  connectorsRoute,
  connectorUuid,
  permissionKeys,
} from "../electron/official-ui/api/connectors";
import { organizationUuid } from "../electron/official-ui/api/context";
import { bootstrapOf } from "../electron/official-ui/api/bootstrap";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
function fixture() {
  let owner = "owner",
    identity = {},
    readOnly = false,
    authorization: ((kind: "add" | "probe") => void) | undefined;
  const calls: [string, unknown[]][] = [];
  const conversations = new Map<string, unknown>();
  const server = {
    name: "wiki",
    url: "https://example.com/mcp",
    state: "ready",
    tools: 1,
    toolList: [{ name: "lookup", description: "Lookup", enabled: true }],
  };
  let answer: (
    name: string,
    args: unknown[],
  ) => Promise<unknown> = async () => ({ servers: [server] });
  const config: any = { wiki: { url: server.url } };
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    settings: () => ({ mcpServers: config }),
    loadConversation: async (id: string) => conversations.get(id),
    get readOnly() {
      return readOnly;
    },
    get allowCustomConnectorCreation() {
      return !!authorization;
    },
    get authorizeCustomConnector() {
      return authorization;
    },
    call: async (name: string, ...args: unknown[]) => {
      calls.push([name, args]);
      return answer(name, args);
    },
    log: () => {},
  };
  const scope = newAdapterScope(owner);
  return {
    calls,
    ctx,
    server,
    config,
    conversations,
    setAnswer: (fn: typeof answer) => (answer = fn),
    retire: () => {
      identity = {};
    },
    readOnly: () => {
      readOnly = true;
    },
    authorize: (authorize: NonNullable<typeof authorization>) => {
      authorization = authorize;
    },
    async run(
      suffix: string,
      method = "GET",
      body?: unknown,
      org = organizationUuid(owner),
    ) {
      const target = suffix.startsWith("/")
        ? suffix
        : `/api/organizations/${org}/mcp/${suffix}`;
      const p = new URL(target, "http://localhost").pathname;
      let status = 0,
        output = "";
      const req: any = Readable.from(
        body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
      );
      req.method = method;
      req.url = target;
      req.headers = { "content-type": "application/json" };
      const res: any = {
        writeHead: (n: number) => {
          status = n;
        },
        write: (s: string) => {
          output += s;
        },
        end: (s = "") => {
          output += s;
        },
      };
      const handled = await inAdapterScope(scope, () =>
        connectorsRoute(req, res, p, ctx),
      );
      return { status, output, handled };
    },
  };
}

test("account bootstrap publishes custom creation only for authorized current hosts", async () => {
  const scope = newAdapterScope("owner");
  const context = {
    root: "/tmp/claudex-no-recorded-defaults",
    account: () => ({ id: "owner" }),
    isCurrent: () => true,
    settings: () => ({}),
    modelCatalog: async () => null,
    log() {},
    call: async () => undefined,
    localCall: async (method: string) => {
      assert.equal(method, "clientPolicy");
      return { localMcpEditing: true };
    },
  } as unknown as Parameters<typeof bootstrapOf>[0];
  const marker = async (patch: Partial<typeof context> = {}) =>
    (await inAdapterScope(scope, () => bootstrapOf({ ...context, ...patch })))
      .account?.claudex_custom_connector_creation;
  assert.equal(await marker(), true);
  assert.equal(
    await marker({ localCall: async () => ({ localMcpEditing: false }) }),
    undefined,
  );
  assert.equal(await marker({ readOnly: true }), undefined);
  assert.equal(
    await marker({ readOnly: true, allowCustomConnectorCreation: true }),
    undefined,
  );
  assert.equal(
    await marker({
      readOnly: true,
      allowCustomConnectorCreation: true,
      authorizeCustomConnector() {},
    }),
    true,
  );
  assert.equal(await marker({ isCurrent: () => false }), undefined);
});
test("connector exact routes reject foreign organizations and mutation methods before calls", async () => {
  const f = fixture();
  assert.equal(
    (await f.run("remote_servers", "GET", undefined, organizationUuid("other")))
      .status,
    404,
  );
  assert.equal((await f.run("/unrelated/mcp/remote_servers")).handled, false);
  assert.equal((await f.run("v2/bootstrap", "POST")).status, 405);
  assert.equal(f.calls.length, 0);
  f.readOnly();
  assert.equal(
    (await f.run("remote_servers", "POST", { name: "Wiki", url: f.server.url }))
      .status,
    403,
  );
  assert.equal(
    (await f.run("start-auth/" + connectorUuid("wiki"))).status,
    403,
  );
  assert.equal((await f.run("remote_servers")).status, 200);
});
test("OAuth logout uses the configured connector and preserves tool approvals", async () => {
  const f = fixture(),
    id = connectorUuid("wiki");
  const logout = "logout/" + id;
  assert.equal((await f.run(logout)).status, 405);
  assert.equal((await f.run(logout + "?via=other", "POST")).status, 400);
  assert.equal((await f.run(logout, "POST", {})).status, 413);
  assert.equal((await f.run("logout/" + connectorUuid("other"), "POST")).status, 404);
  assert.equal(f.calls.length, 0);

  f.setAnswer(async () => false);
  const unavailable = await f.run(logout, "POST");
  assert.equal(unavailable.status, 501);
  assert.equal(JSON.parse(unavailable.output).error.type, "invalid_request_error");
  f.setAnswer(async () => true);
  assert.deepEqual(await f.run(logout + "?via=wallet", "POST"), {
    status: 204,
    output: "",
    handled: true,
  });
  assert.deepEqual(f.calls, [
    ["revokeConnector", ["wiki", f.server.url]],
    ["revokeConnector", ["wiki", f.server.url]],
  ]);
});

test("tool refresh requires a successful discovery", async () => {
  const f = fixture();
  const id = connectorUuid("wiki");
  assert.equal(
    (await f.run("remote_servers/" + id + "/clear_cache", "POST")).status,
    503,
  );
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["refreshConnectorTools"],
  );
});
test("inventory configuration failures and probe failures are visible, sanitized, not empty/no_server", async () => {
  const f = fixture();
  f.setAnswer(async () => ({
    servers: [],
    configError: "invalid config secret",
  }));
  const list = await f.run("remote_servers");
  assert.equal(list.status, 503);
  assert.ok(!list.output.includes("secret"));
  f.setAnswer(async (name) => {
    if (name === "mcpServers") return { servers: [] };
    throw Error("bearer credential secret");
  });
  const probe = await f.run("probe", "POST", {
    url: "https://example.com/new",
  });
  assert.equal(probe.status, 503);
  assert.ok(!/secret|no_server/.test(probe.output));
  f.setAnswer(async (name) =>
    name === "mcpServers"
      ? { servers: [] }
      : { authRequired: true, transport: "streamable-http" },
  );
  const valid = await f.run("probe", "POST", {
    url: "https://example.com/new",
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(probeEvents(valid.output), [
    {
      step: "result",
      status: "detected",
      reason: null,
      transport: "streamable-http",
      posture: "auth_required",
      suggested_registration: null,
      discovery_timed_out: false,
    },
  ]);
});

const probeEvents = (sse: string) =>
  sse
    .trim()
    .split("\n\n")
    .map((event) => JSON.parse(event.split("\n")[1].slice("data: ".length)));

test("official probe distinguishes an existing URL, discovery errors and egress refusal", async () => {
  const f = fixture();
  const existing = await f.run("probe", "POST", {
    url: f.server.url.replace("example", "EXAMPLE"),
  });
  assert.equal(probeEvents(existing.output)[0].status, "already_exists");
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ["mcpServers"],
  );
  let failure: Error = new ConnectorProbeError("http_connect_failed");
  f.setAnswer(async (name) => {
    if (name === "mcpServers") return { servers: [f.server] };
    throw failure;
  });
  const body = {
    url: f.server.url,
    exclude_server_uuid: connectorUuid(f.server.name),
  };
  const unavailable = await f.run("probe", "POST", body);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(probeEvents(unavailable.output)[0], {
    step: "initialize",
    outcome: "failed",
    http_status: null,
    error: "http_connect_failed",
  });
  assert.equal(probeEvents(unavailable.output)[1].status, "unknown");
  failure = new ConnectorProbeError("not_found", 404);
  const missing = await f.run("probe", "POST", body);
  assert.equal(probeEvents(missing.output)[0].http_status, 404);
  assert.equal(probeEvents(missing.output)[1].status, "no_server");
  failure = new ConnectorAddressError("denied", "private host");
  const denied = await f.run("probe", "POST", body);
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.output, /private host|event: message/);
});
test("late same-account activation rejects inventory, probe and auth acknowledgements", async () => {
  for (const target of [
    "remote_servers",
    "probe",
    "start-auth/" + connectorUuid("wiki"),
  ]) {
    const f = fixture();
    f.setAnswer(async (name) => {
      if (target === "remote_servers" || name !== "mcpServers") f.retire();
      return name === "mcpServers"
        ? { servers: [f.server] }
        : { authRequired: false, transport: "streamable-http" };
    });
    const result = await f.run(
      target,
      target === "probe" ? "POST" : "GET",
      target === "probe" ? { url: "https://example.com/new" } : undefined,
    );
    assert.equal(result.status, 409);
    assert.ok(!result.output.includes('"servers"'));
  }
});
test("organization policy contracts never grant personal permissions; unsupported edits reject", async () => {
  const f = fixture(),
    target = "remote_servers/" + connectorUuid("wiki");
  const unrestricted = await f.run(target + "/tool_policies");
  assert.equal(unrestricted.status, 200);
  assert.deepEqual(JSON.parse(unrestricted.output), []);
  Object.assign(f.ctx, { connectorAlwaysAllow: () => false });
  const restricted = await f.run(target + "/tool_policies");
  assert.equal(restricted.status, 200);
  assert.deepEqual(JSON.parse(restricted.output), [{ tool_name: "*", max_permission: "ask" }]);
  for (const [suffix, method, body] of [
    ["/tool_policies/lookup", "PUT", { max_permission: "allow" }],
    ["/tool_policies/lookup", "DELETE", undefined],
    [
      "/tool_policies",
      "POST",
      { policies: [{ tool_name: "lookup", policy: "always_allow" }] },
    ],
  ] as const)
    assert.equal((await f.run(target + suffix, method, body)).status, 501);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run(target, "PATCH", { is_enabled: false })).status,
    400,
  );
  assert.equal(
    (await f.run("remote_servers", "POST", { name: [], url: f.server.url }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.run("remote_servers", "POST", {
        name: "Wiki",
        url: f.server.url,
        oauth_overrides: { bad: true },
      })
    ).status,
    400,
  );
  assert.ok(f.calls.every((c) => c[0] === "mcpServers"));
});
test("valid tool policy uses existing atomic policy service and reconciles real result", async () => {
  const f = fixture();
  f.setAnswer(async (name, args) => {
    if (name === "setConnectorToolPermissions") {
      assert.deepEqual(args[0], [
        { name: "wiki", tool: "lookup", permission: "block" },
      ]);
      f.server.toolList[0].enabled = false;
      f.config.wiki.disabled_tools = ["lookup"];
    }
    return { servers: [f.server] };
  });
  const key = permissionKeys(f.server as never, f.server.toolList[0]);
  const r = await f.run("/api/account/settings", "PATCH", {
    enabled_mcp_tools: { [key.enabled]: false },
  });
  assert.equal(r.status, 200);
  assert.equal(
    f.calls.filter((c) => c[0] === "setConnectorToolPermissions").length,
    1,
  );
});
test("valid custom creation keeps native authorization service and unsupported metadata never writes", async () => {
  const f = fixture();
  const url = "https://example.com/";
  const displayName = "F040 Native Wiki";
  const name = "F040-Native-Wiki-2";
  f.config["F040-Native-Wiki"] = { command: "existing-local-tool" };
  f.setAnswer(async (name, args) => {
    if (name === "addCustomConnector") {
      assert.deepEqual(args[0], {
        name: "F040-Native-Wiki-2",
        displayName,
        url,
        transport: "sse",
      });
      f.config["F040-Native-Wiki-2"] = { display_name: displayName, url };
      throw Error("Engine is not connected");
    }
    return { servers: [f.server] };
  });
  const r = await f.run("remote_servers", "POST", {
    name: displayName,
    url: "https://EXAMPLE.com",
    attestations: [],
    oauth_overrides: null,
    user_confirmed: true,
    install: {
      type: "custom",
      transport: "sse",
      posture: "no_auth",
      inputs: [],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.output).uuid, connectorUuid(name));
  assert.equal(JSON.parse(r.output).name, displayName);
  assert.equal(JSON.parse(r.output).url, url);
  assert.equal(f.calls.filter((c) => c[0] === "addCustomConnector").length, 1);
  assert.equal(
    (
      await f.run("remote_servers", "POST", {
        name: "wiki",
        url: f.server.url,
        attestations: [{ type: "safe_for_phi", content_hash: "fake" }],
      })
    ).status,
    501,
  );
  assert.equal(f.calls.filter((c) => c[0] === "addCustomConnector").length, 1);
});

test("original OAuth install fields reach the owner service only with the exact Web grant", async () => {
  const f = fixture();
  f.readOnly();
  const url = "https://example.com/oauth";
  const body = {
    name: "Private Wiki",
    url,
    install: {
      type: "custom",
      posture: "auth_required",
      transport: "streamable-http",
      auth_method: {
        type: "oauth",
        registration: {
          type: "static_per_installation",
          client_credential: { type: "client_secret" },
        },
        mcp_request_headers: [],
      },
      inputs: [
        {
          type: "oauth_method_input",
          name: "client_id",
          value: "owner-client",
        },
        {
          type: "oauth_client_credential",
          name: "client_secret",
          value: "owner-secret",
        },
      ],
    },
  };
  assert.equal((await f.run("remote_servers", "POST", body)).status, 403);
  assert.equal(f.calls.length, 0);
  const authorization: string[] = [];
  f.authorize((kind) => {
    authorization.push(kind);
  });
  f.setAnswer(async (method, args) => {
    assert.equal(method, "addCustomConnector");
    assert.deepEqual(args, [
      {
        name: "Private-Wiki",
        displayName: body.name,
        url,
        clientId: "owner-client",
        clientSecret: "owner-secret",
        transport: "streamable-http",
        oauth: { registration: "static_per_installation", posture: "auth_required" },
      },
    ]);
    return {
      servers: [
        { ...f.server, name: "Private-Wiki", displayName: body.name, url },
      ],
    };
  });
  const added = await f.run("remote_servers", "POST", body);
  assert.equal(added.status, 200);
  assert.doesNotMatch(added.output, /owner-secret/);
  assert.deepEqual(authorization, ["add"]);
  assert.equal(
    (await f.run("remote_servers/" + connectorUuid("Private-Wiki"), "DELETE"))
      .status,
    403,
  );
  const withUnsupportedInstall = await f.run("remote_servers", "POST", {
    ...body,
    install: {
      ...body.install,
      inputs: [],
      auth_method: { type: "oauth", registration: { type: "cimd" } },
      grant: { grant_type: "id_jag", config: {} },
    },
  });
  assert.equal(withUnsupportedInstall.status, 501);
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ["addCustomConnector"],
  );
});

test("original CIMD install preserves validated OAuth overrides", async () => {
  const f = fixture();
  const url = "https://example.com/cimd";
  const overrides = { request_parameters: { scopes: ["read"] } };
  f.setAnswer(async (method, args) => {
    assert.equal(method, "addCustomConnector");
    assert.deepEqual(args, [{
      name: "CIMD-Wiki", displayName: "CIMD Wiki", url, transport: "streamable-http",
      oauth: { registration: "cimd", posture: "auth_required", overrides },
    }]);
    return { servers: [{ ...f.server, name: "CIMD-Wiki", url }] };
  });
  const response = await f.run("remote_servers", "POST", {
    name: "CIMD Wiki", url,
    install: { type: "custom", posture: "auth_required", transport: "streamable-http",
      auth_method: { type: "oauth", registration: { type: "cimd" } },
      oauth_overrides: overrides, inputs: [],
    },
  });
  assert.equal(response.status, 200);
});

test("original DCR add fails when the owner service does not save the connector", async () => {
  const f = fixture();
  const url = "https://example.com/dcr";
  f.setAnswer(async (method, args) => {
    if (method === "addCustomConnector")
      assert.deepEqual(args, [
        {
          name: "DCR-Wiki",
          displayName: "DCR Wiki",
          url,
          transport: "streamable-http",
          oauth: { registration: "dcr", posture: "auth_required" },
        },
      ]);
    return { servers: [f.server] };
  });
  const missing = await f.run("remote_servers", "POST", {
    name: "DCR Wiki",
    url,
    install: {
      type: "custom",
      posture: "auth_required",
      transport: "streamable-http",
      auth_method: { type: "oauth", registration: { type: "dcr" } },
      inputs: [],
    },
  });
  assert.equal(missing.status, 503);
  assert.doesNotMatch(missing.output, /"uuid"/);
});

test("original custom installs pass request headers to the owner without exposing their values", async () => {
  const f = fixture();
  const url = "https://example.com/private-mcp";
  const required = { name: "Authorization", scope: "organization", required: true };
  const optional = { name: "X-Tenant-ID", scope: "organization", required: false };
  const header = { type: "mcp_request_header", name: "Authorization", value: "Key private-header" };
  const install = {
    type: "custom",
    posture: "auth_required",
    transport: "streamable-http",
    auth_method: { type: "static_headers", mcp_request_headers: [required, optional] },
    inputs: [header],
  };
  const body = { name: "Static Wiki", url, install };
  f.setAnswer(async (method, args) => {
    assert.equal(method, "addCustomConnector");
    assert.deepEqual(args, [{
      name: "Static-Wiki", displayName: body.name, url,
      transport: "streamable-http", staticAuth: true,
      headers: { authorization: "Key private-header" },
    }]);
    return { servers: [{ ...f.server, name: "Static-Wiki", url }] };
  });
  const added = await f.run("remote_servers", "POST", body);
  assert.equal(added.status, 200);
  assert.doesNotMatch(added.output, /private-header|X-Tenant-ID/i);

  const auth_method = { ...install.auth_method, mcp_request_headers: [required, { ...optional, required: true }] };
  const invalid = [
    { ...install, auth_method },
    { ...install, inputs: [header, { ...header, name: "authorization" }] },
    { ...install, inputs: [{ ...header, name: "X-Undeclared" }] },
    { ...install, auth_method: { ...install.auth_method, mcp_request_headers: [required, { ...optional, name: "authorization" }] } },
    { ...install, auth_method: { ...install.auth_method, type: "oauth", registration: { type: "dcr" } } },
  ];
  for (const request of invalid) {
    const result = await f.run("remote_servers", "POST", { ...body, install: request });
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.output, /private-header/);
  }
  assert.equal(f.calls.length, 1);
});
test("personal policy unknown keys and oversized request never write", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.run("/api/account/settings", "PATCH", {
        enabled_mcp_tools: { forged: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.run("probe", "POST", { url: "x".repeat(1024 * 1024) })).status,
    413,
  );
  assert.ok(f.calls.every((c) => c[0] === "mcpServers"));
});
test("source rejection remains a visible auth failure rather than popup success", async () => {
  const f = fixture();
  f.setAnswer(async (name) => {
    if (name === "mcpServers") return { servers: [f.server] };
    throw Error("token=private");
  });
  const r = await f.run("start-auth/" + connectorUuid("wiki"));
  assert.equal(r.status, 503);
  assert.ok(!/private|window.close/.test(r.output));
});

test("native original start-auth JSON prepares only when authentication is required", async () => {
  const f = fixture();
  const path =
    "start-auth/" + connectorUuid(f.server.name) + "?response_format=json";
  const ready = await f.run(path);
  assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(ready.output), { connected: true });
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ["mcpServers"],
  );
  const authUrl = "https://issuer.example.com/authorize?state=private-attempt";
  Object.assign(f.server, { authStatus: "notLoggedIn" });
  f.setAnswer(async (method, args) => {
    if (method === "mcpServers") return { servers: [f.server] };
    assert.deepEqual(args, [f.server.name, undefined, true]);
    return authUrl;
  });
  const challenge = await f.run(path);
  assert.equal(challenge.status, 200);
  assert.deepEqual(JSON.parse(challenge.output), {
    auth_url: authUrl,
    state: "private-attempt",
  });
  Object.assign(f.server, { authStatus: undefined, tools: 0, toolList: [] });
  const unverified = await f.run(path);
  assert.equal(unverified.status, 200);
  assert.equal(JSON.parse(unverified.output).auth_url, authUrl);
  Object.assign(f.server, { state: "disabled" });
  assert.equal((await f.run(path)).status, 503);
});

test("bootstrap finishes proven server/tool transport without fabricating resource completeness", async () => {
  const f = fixture();
  const r = await f.run("v2/bootstrap");
  assert.equal(r.status, 200);
  assert.match(r.output, /event: tools/);
  assert.match(r.output, /event: completed/);
  assert.ok(!r.output.includes("event: resources"));
  assert.ok(!r.output.includes('"complete":true'));
});

test("bootstrap publishes the original connection status for an OAuth challenge", async () => {
  const f = fixture();
  const base = async () => {
    const r = await f.run("v2/bootstrap");
    return JSON.parse(/event: server_base\ndata: (.+)/.exec(r.output)![1]);
  };
  Object.assign(f.server, { authStatus: "notLoggedIn" });
  assert.deepEqual(await base(), {
    uuid: connectorUuid(f.server.name),
    name: f.server.name,
    url: f.server.url,
    connected: false,
    authStatus: "auth_required",
    usedAuthentication: false,
  });
  Object.assign(f.server, { authStatus: "oAuth" });
  assert.deepEqual(await base(), {
    uuid: connectorUuid(f.server.name),
    name: f.server.name,
    url: f.server.url,
    connected: true,
    authStatus: "authenticated",
    usedAuthentication: true,
  });
});

test("failed bootstrap uses generic consumer connectionError without inventing OAuth or leaking raw errors", async () => {
  const f = fixture();
  Object.assign(f.server, {
    state: "failed",
    error: "token=private runtime detail",
  });
  const r = await f.run("v2/bootstrap");
  assert.equal(r.status, 200);
  assert.match(r.output, /"connectionError":"connection_failed"/);
  assert.ok(
    !/private|authErrorType|retry_transient|managed_auth/.test(r.output),
  );
  Object.assign(f.server, { state: "disabled" });
  const disabled = await f.run("v2/bootstrap");
  assert.ok(
    !/connectionError|member_turned_off|org_policy/.test(disabled.output),
  );
});

test("bootstrap preserves actual tool schema and supported annotations, not arbitrary source metadata", async () => {
  const f = fixture();
  const schema = {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  };
  Object.assign(f.server.toolList[0], {
    definition: {
      name: "lookup",
      inputSchema: schema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        title: "Lookup",
        unknownPrivateKey: "secret",
      },
      _meta: { private: "secret" },
    },
  });
  const r = await f.run("v2/bootstrap");
  assert.equal(r.status, 200);
  const block = r.output
    .split("\n\n")
    .find((x) => x.startsWith("event: tools"))!;
  const tool = JSON.parse(block.split("\ndata: ")[1]).tools[0];
  assert.deepEqual(tool.inputSchema, schema);
  assert.deepEqual(tool.annotations, {
    title: "Lookup",
    readOnlyHint: true,
    destructiveHint: false,
  });
  assert.ok(!r.output.includes("secret"));
});

test("missing schema and unknown access stay absent, proven access hint remains labeled", async () => {
  const f = fixture();
  const plain = await f.run("v2/bootstrap");
  assert.ok(!/inputSchema|annotations/.test(plain.output));
  Object.assign(f.server.toolList[0], { access: "readOnly" });
  const hint = await f.run("v2/bootstrap");
  assert.match(hint.output, /"readOnlyHint":true/);
  assert.ok(!hint.output.includes("inputSchema"));
});

test("malformed and excessive tool metadata fail before any successful SSE header or partial catalog", async () => {
  for (const definition of [
    { name: "other", inputSchema: {} },
    { name: "lookup", inputSchema: [] },
    {
      name: "lookup",
      inputSchema: { description: "x".repeat(256 * 1024 + 1) },
    },
    { name: "lookup", annotations: { readOnlyHint: "true" } },
  ]) {
    const f = fixture();
    Object.assign(f.server.toolList[0], { definition });
    const r = await f.run("v2/bootstrap");
    assert.equal(r.status, 503);
    assert.ok(!r.output.includes("event: server_list"));
  }
  const f = fixture();
  const schema: any = {};
  schema.self = schema;
  Object.assign(f.server.toolList[0], {
    definition: { name: "lookup", inputSchema: schema },
  });
  const r = await f.run("v2/bootstrap");
  assert.equal(r.status, 503);
  assert.ok(!r.output.includes("event: tools"));
});

test("native Connect opens OAuth after the recorded protected tool rejects an anonymous connection", async () => {
  const f = fixture();
  const id = "11111111-1111-4111-8111-111111111111";
  f.conversations.set(id, { mode: "chat", turns: [{ id: "turn", items: [{ ...protectedToolFailure, mcpAuthRejectionUrl: f.server.url }] }] });
  const authUrl = "https://issuer.example.com/authorize?state=deferred";
  Object.assign(f.server, { authStatus: "unsupported" });
  f.setAnswer(async (name, args) => {
    if (name === "mcpServers") return { servers: [f.server] };
    assert.equal(name, "connectConnector");
    assert.deepEqual(args, ["wiki", undefined, true]);
    return authUrl;
  });
  const start = "start-auth/" + connectorUuid(f.server.name) + "?response_format=json";
  assert.deepEqual(JSON.parse((await f.run(start)).output), { connected: true });
  const rejection = start + "&after_auth_rejection=true&conversation_uuid=" + id + "&tool_use_id=turn:";
  assert.equal((await f.run(rejection + "other-tool")).status, 404);
  const answer = await f.run(rejection + "protected-call");
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.output), { auth_url: authUrl, state: "deferred" });
});

test("native Settings reconnects an expired OAuth grant without a tool call", async () => {
  const f = fixture();
  const start = `start-auth/${connectorUuid(f.server.name)}?response_format=json&after_auth_rejection=true`;
  const authUrl = "https://issuer.example.com/authorize?state=reconnect";
  f.setAnswer(async (name) =>
    name === "mcpServers" ? { servers: [f.server] } : authUrl,
  );
  assert.equal((await f.run(start)).status, 409);
  Object.assign(f.server, {
    state: "stopped",
    authStatus: "notLoggedIn",
    oauthStatus: "reconnect",
  });
  assert.deepEqual(JSON.parse((await f.run(start)).output), {
    auth_url: authUrl,
    state: "reconnect",
  });
  const row = JSON.parse((await f.run("remote_servers_with_connection")).output)[0];
  assert.equal(row.connection_auth_type, "mcp_oauth");
  assert.equal(row.connection_state, "error");
  assert.equal(row.is_authenticated, false);
  Object.assign(f.server, { oauthStatus: "disconnected" });
  const disconnected = JSON.parse((await f.run("remote_servers_with_connection")).output)[0];
  assert.equal(disconnected.connection_state, "user_disconnected");
  Object.assign(f.server, { state: "ready", authStatus: "bearerToken", oauthStatus: "connected" });
  const connected = JSON.parse((await f.run("remote_servers_with_connection")).output)[0];
  assert.equal(connected.connection_state, "connected");
  assert.equal(connected.is_authenticated, true);
});

function knowledgeOffer(available: boolean) {
  return {
    baseUrl: "https://claudex.example.com/service",
    bases: [{
      id: "huaner-tech",
      name: "幻尔科技知识库",
      description: "产品文档、课程和源码",
      available,
    }],
  };
}

test("managed knowledge uses the official server and tool catalog with a default-off account baseline", async () => {
  const f = fixture();
  f.ctx.root = "/tmp/claudex-no-recorded-defaults";
  f.ctx.modelCatalog = async () => null;
  f.ctx.connectorAlwaysAllow = () => false;
  f.ctx.knowledgeOffer = async () => knowledgeOffer(true);
  const uuid = connectorUuid("knowledge_huaner_tech");
  const url = "https://claudex.example.com/service/v1/claudex/knowledge/huaner-tech/mcp";

  const inventory = await f.run("remote_servers_with_connection");
  assert.equal(inventory.status, 200);
  const row = JSON.parse(inventory.output).find((entry: { uuid: string }) => entry.uuid === uuid);
  assert.deepEqual(
    { name: row.name, description: row.description, url: row.url, connected: row.connected, flags: row.cai_flags },
    { name: "幻尔科技知识库", description: "产品文档、课程和源码", url, connected: true, flags: ["claudex_managed"] },
  );
  assert.equal(row.is_authenticated, false);
  assert.equal(row.label_editable, false);
  assert.equal(row.additional_install, false);
  assert.equal(row.mcp_directory_server_uuid, undefined);
  const detail = await f.run("remote_servers/" + uuid);
  assert.equal(detail.status, 200);
  assert.equal(JSON.parse(detail.output).description, row.description);

  const catalog = await f.run("v2/bootstrap");
  const events = catalog.output.trim().split("\n\n").map((event) => {
    const [name, data] = event.split("\ndata: ");
    return { ...JSON.parse(data), event: name };
  });
  const serverBase = events.find((event) => event.event === "event: server_base" && event.uuid === uuid);
  assert.equal(serverBase.url, url);
  assert.deepEqual(serverBase.cai_flags, ["claudex_managed"]);
  const { tools } = events.find((event) => event.event === "event: tools" && event.server_uuid === uuid);
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["rag_search", "rag_read"]);
  assert.deepEqual(tools[0].inputSchema.required, ["query"]);
  assert.deepEqual(tools[1].inputSchema.required, ["path"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].effective_max_permission, "ask");

  f.setAnswer(async () => undefined);
  const account = (await inAdapterScope(newAdapterScope("owner"), () => bootstrapOf(f.ctx))).account;
  assert.equal(account?.settings.enabled_mcp_tools[uuid + ":rag_search"], false);
  assert.equal(account?.settings.enabled_mcp_tools[uuid + ":rag_read"], false);
  assert.equal(account?.settings.enabled_mcp_tools[tools[0].always_approved_key], false);
  assert.deepEqual(Object.keys(f.config), ["wiki"]);
});

test("managed knowledge stays read-only and a failed offer lookup leaves ordinary connectors available", async () => {
  const f = fixture();
  const uuid = connectorUuid("knowledge_huaner_tech");
  f.ctx.knowledgeOffer = async () => knowledgeOffer(false);
  const inventory = JSON.parse((await f.run("remote_servers_with_connection")).output);
  const offline = inventory.find((row: { uuid: string }) => row.uuid === uuid);
  assert.equal(offline.connected, false);
  assert.equal(offline.connection_state, "error");
  assert.match((await f.run("v2/bootstrap")).output, /"connectionError":"connection_failed"/);

  for (const [suffix, method, body] of [
    ["remote_servers/" + uuid, "PATCH", { name: "Other" }],
    ["remote_servers/" + uuid, "DELETE"],
    ["remote_servers/" + uuid + "/clear_cache", "POST"],
    ["logout/" + uuid, "POST"],
    ["start-auth/" + uuid, "GET"],
  ] as const) {
    assert.equal((await f.run(suffix, method, body)).status, 403);
  }
  const settings = await f.run("/api/account/settings", "PATCH", {
    enabled_mcp_tools: { [uuid + ":rag_read"]: true },
  });
  assert.equal(settings.status, 200);
  assert.equal(JSON.parse(settings.output).settings.enabled_mcp_tools[uuid + ":rag_read"], false);
  assert.ok(f.calls.every(([method]) => method === "mcpServers"));

  f.ctx.knowledgeOffer = async () => { throw Error("backend unavailable"); };
  const unrelated = await f.run("remote_servers");
  assert.equal(unrelated.status, 200);
  assert.deepEqual(JSON.parse(unrelated.output).map((row: { name: string }) => row.name), ["wiki"]);
  assert.equal((await f.run("remote_servers/" + uuid)).status, 404);
  const hidden = (await f.run("v2/bootstrap")).output;
  assert.ok(hidden.includes('"deleted_server_uuids":' + JSON.stringify([uuid])));
});
