/** F041 isolated host routes and saved-policy projections; no real connector or UI execution. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { connectorInventory } from "../electron/official-ui/api/connector-inventory";
import {
  connectorsRoute,
  connectorUuid,
  connectorToolSettings,
  permissionKeys,
  waitForConnectorToolChanges,
} from "../electron/official-ui/api/connectors";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { sessionConnectors } from "../electron/official-ui/native/session-connectors";
import { withToolApproval } from "../shared/mcp-tool-approval";
import type {
  McpServerState,
  McpToolState,
} from "../shared/settings-desktop-api";
import type { Conversation } from "../shared/types";

const tool = (name = "lookup"): McpToolState => ({
  name,
  description: "Find a fact",
  enabled: true,
  access: "readOnly",
  definition: {
    name,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search text" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
});
function fixture(name = "lookup") {
  let owner = "f041",
    identity = {},
    config: Record<string, any> = { wiki: { url: "https://example.test/mcp" } };
  const server: McpServerState = {
    name: "wiki",
    url: config.wiki.url,
    state: "ready",
    tools: 1,
    toolList: [tool(name)],
  };
  const scope = newAdapterScope(owner),
    calls: any[][] = [];
  let conversation = {
    id: "one",
    mode: "code",
    turns: [],
  } as unknown as Conversation;
  let answer = async (method: string, ...args: any[]): Promise<any> => {
    if (method === "mcpServers") return { servers: [server] };
    if (method === "updateConversation")
      return (conversation = {
        ...conversation,
        ...args[1].connectorToolOverrides.value,
      });
    if (method === "setConnectorToolPermissions") {
      for (const change of args[0]) {
        const raw = config[change.name];
        const disabled = new Set(raw.disabled_tools ?? []);
        if (change.permission === "block") disabled.add(change.tool);
        else disabled.delete(change.tool);
        config[change.name] = withToolApproval(
          { ...raw, disabled_tools: [...disabled] },
          change.tool,
          change.permission === "allow"
            ? "approve"
            : change.permission === "ask"
              ? "prompt"
              : undefined,
        );
      }
      return { servers: [server] };
    }
    throw Error(`Unexpected ${method}`);
  };
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    settings: () => ({ mcpServers: config }),
    call: async (method: string, ...args: any[]) => {
      calls.push([method, ...args]);
      return answer(method, ...args);
    },
    log() {},
  };
  const methods = sessionConnectors(
    async () => structuredClone(conversation),
    ctx.call,
    ctx,
  );
  return {
    ctx,
    scope,
    server,
    calls,
    methods,
    config: () => config,
    replaceConfig: (c: typeof config) => (config = c),
    retire: () => (identity = {}),
    answer: (fn: typeof answer) => (answer = fn),
    conversation: () => conversation,
    async run(body?: unknown, suffix = "/api/account/settings") {
      const path = suffix.startsWith("/")
        ? suffix
        : `/api/organizations/${organizationUuid(owner)}/mcp/${suffix}`;
      const req: any = Readable.from(
        body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
      );
      req.method = body === undefined ? "GET" : "PATCH";
      req.headers = { "content-type": "application/json" };
      let status = 0,
        output = "";
      const res: any = {
        writeHead: (n: number) => (status = n),
        write: (s: string) => (output += s),
        end: (s = "") => (output += s),
      };
      await inAdapterScope(scope, () => connectorsRoute(req, res, path, ctx));
      return { status, output };
    },
  };
}

test("account tool settings update installed local extension permissions", async () => {
  const f = fixture("echo");
  f.server.name = "fixture";
  f.server.command = "node server.js";
  delete f.server.url;
  f.replaceConfig({ fixture: { command: "node", claudex_extension: "/test/fixture", claudex_extension_id: "local.mcpb.test.fixture" } });
  f.ctx.localMcpConfig = () => "{}";
  const keys = permissionKeys(f.server, f.server.toolList![0], f.ctx);
  assert.equal(keys.enabled, "local:local.mcpb.test.fixture:echo");
  const blocked = await f.run({ enabled_mcp_tools: { [keys.enabled]: false } });
  assert.equal(blocked.status, 200);
  assert.deepEqual(f.config().fixture.disabled_tools, ["echo"]);
  const allowed = await f.run({ enabled_mcp_tools: { [keys.enabled]: true, [keys.approved]: true } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(f.config().fixture.disabled_tools, []);
  assert.equal(f.config().fixture.tools.echo.approval_mode, "approve");
});

test("a blocked local extension tool can return to approval after restart", async () => {
  const f = fixture("echo");
  f.server.name = "fixture";
  f.server.command = "node server.js";
  delete f.server.url;
  f.replaceConfig({ fixture: { command: "node", claudex_extension: "/test/fixture", claudex_extension_id: "local.mcpb.test.fixture", disabled_tools: ["echo"] } });
  f.ctx.localMcpConfig = () => "{}";
  const keys = permissionKeys(f.server, f.server.toolList![0], f.ctx);
  f.server.toolList = [{ name: "echo", description: "", enabled: false }];
  assert.equal((await f.run({ enabled_mcp_tools: { [keys.approved]: true } })).status, 400);
  const result = await f.run({ enabled_mcp_tools: { [keys.enabled]: true, [keys.approved]: false } });
  assert.equal(result.status, 200);
  assert.deepEqual(f.config().fixture.disabled_tools, []);
});

test("the original tool inventory exposes the administrator's approval ceiling", async () => {
  const f = fixture();
  f.ctx.connectorAlwaysAllow = () => false;
  const stream = await f.run(undefined, "v2/bootstrap");
  assert.equal(stream.status, 200);
  const [row] = JSON.parse(/event: tools\ndata: (.*)/.exec(stream.output)![1]).tools;
  assert.equal(row.org_max_permission, "ask");
  assert.equal(row.effective_max_permission, "ask");
  const keys = permissionKeys(f.server, f.server.toolList![0]);
  const refused = await f.run({ enabled_mcp_tools: { [keys.enabled]: true, [keys.approved]: true } });
  assert.equal(refused.status, 403);
  assert.match(refused.output, /administrator requires approving each request/);
  assert.equal(f.config().wiki.tools, undefined);
});

test("F041 Block keeps proven schema, access hints and permission keys; live replacement does not keep old metadata", () => {
  const f = fixture(),
    original = tool();
  const first = connectorInventory(f.ctx, [f.server])[0].toolList![0];
  f.config().wiki.disabled_tools = [original.name];
  f.server.toolList = [
    { name: original.name, description: "", enabled: false },
  ];
  const blocked = connectorInventory(f.ctx, [f.server])[0].toolList![0];
  assert.deepEqual(blocked.definition, original.definition);
  assert.equal(blocked.access, "readOnly");
  assert.equal(blocked.enabled, false);
  assert.deepEqual(
    permissionKeys(f.server, blocked),
    permissionKeys(f.server, first),
  );
  f.server.toolList = [
    { name: original.name, description: "Replacement", enabled: true },
  ];
  const changed = connectorInventory(f.ctx, [f.server])[0].toolList![0];
  assert.equal(changed.definition, undefined);
  assert.equal(changed.access, undefined);
});

for (const permission of ["block", "ask", "allow"] as const)
  test(`F041 ${permission} round-trips the account policy and preserved bootstrap metadata`, async () => {
    const f = fixture(),
      keys = permissionKeys(f.server, f.server.toolList![0]);
    f.server.toolList![0].definition!._meta = {
      "ui/resourceUri": "ui://wiki/lookup.html",
      ui: { visibility: ["model", "app"], ignored: true },
      "wiki/private": "internal value",
    };
    const result = await f.run({
      enabled_mcp_tools: {
        [keys.enabled]: permission !== "block",
        [keys.approved]: permission === "allow",
      },
    });
    assert.equal(result.status, 200);
    const map = JSON.parse(result.output).settings.enabled_mcp_tools;
    assert.equal(map[keys.enabled], permission !== "block");
    assert.equal(map[keys.approved], permission === "allow");
    assert.equal(
      f.config().wiki.tools?.lookup?.approval_mode,
      permission === "ask" ? "prompt" : permission === "allow" ? "approve" : undefined,
    );
    if (permission === "block")
      f.server.toolList = [{ name: "lookup", description: "", enabled: false }];
    const stream = await f.run(undefined, "v2/bootstrap");
    assert.equal(stream.status, 200);
    const row = JSON.parse(/event: tools\ndata: (.*)/.exec(stream.output)![1])
      .tools[0];
    assert.deepEqual(row.inputSchema, tool().definition!.inputSchema);
    assert.equal(row.annotations.readOnlyHint, true);
    assert.deepEqual(row._meta, {
      ui: { resourceUri: "ui://wiki/lookup.html", visibility: ["model", "app"] },
    });
    assert.equal(row.always_approved_key, keys.approved);
  });

for (const change of ["description", "parameter"] as const)
  test(`F041 stale ${change} grant is refused but stale key cleanup succeeds`, async () => {
    const f = fixture(),
      old = permissionKeys(f.server, f.server.toolList![0]);
    if (change === "description")
      f.server.toolList![0].description = "New meaning";
    else
      (
        f.server.toolList![0].definition!.inputSchema!.properties as any
      ).query.description = "Different meaning";
    const now = permissionKeys(f.server, f.server.toolList![0]);
    assert.notEqual(old.approved, now.approved);
    assert.equal(
      (await f.run({ enabled_mcp_tools: { [old.approved]: true } })).status,
      400,
    );
    assert.equal(
      f.calls.filter((c) => c[0] === "setConnectorToolPermissions").length,
      0,
    );
    assert.equal(
      (
        await f.run({
          enabled_mcp_tools: { [old.approved]: null, [now.approved]: true },
        })
      ).status,
      200,
    );
  });

test("F041 hex-suffix tool names are enabled keys, not approval fingerprints", async () => {
  const f = fixture("lookup-" + "a".repeat(32)),
    keys = permissionKeys(f.server, f.server.toolList![0]);
  const stale = keys.enabled + "-" + "b".repeat(32);
  assert.equal(
    (await f.run({ enabled_mcp_tools: { [stale]: null } })).status,
    200,
  );
  const result = await f.methods.replaceEnabledMcpTools("one", {
    tools: { [keys.enabled]: false },
  });
  assert.equal(result.enabledMcpTools[keys.enabled], false);
});

for (const failure of ["throws", "partial", "config-error"] as const)
  test(`F041 ${failure} mutation never returns a successful permission choice`, async () => {
    const f = fixture(),
      keys = permissionKeys(f.server, f.server.toolList![0]);
    f.answer(async (name) => {
      if (name === "mcpServers") return { servers: [f.server] };
      if (failure === "throws") throw Error("secret upstream failure");
      if (failure === "config-error")
        return { servers: [f.server], configError: "secret invalid config" };
      return { servers: [f.server] };
    });
    const result = await f.run({
      enabled_mcp_tools: { [keys.enabled]: false },
    });
    assert.equal(result.status, 503);
    assert.ok(!result.output.includes("secret"));
    assert.equal(
      f.calls.filter((c) => c[0] === "setConnectorToolPermissions").length,
      1,
    );
  });

for (const method of ["read", "write"] as const)
  test(`F041 configuration changes during ${method} discovery reject old connector results`, async () => {
    const f = fixture(),
      keys = permissionKeys(f.server, f.server.toolList![0]);
    f.answer(async (name) => {
      assert.equal(name, "mcpServers");
      f.config().wiki.url = "https://replacement.test/mcp";
      return { servers: [f.server] };
    });
    const result = await f.run(
      method === "write"
        ? { enabled_mcp_tools: { [keys.approved]: true } }
        : undefined,
      method === "write" ? "/api/account/settings" : "v2/bootstrap",
    );
    assert.equal(result.status, 409);
    assert.equal(f.calls.length, 1);
  });

test("F041 late account activation cannot save or expose a tool inventory", async () => {
  const f = fixture(),
    keys = permissionKeys(f.server, f.server.toolList![0]);
  f.answer(async () => {
    f.retire();
    return { servers: [f.server] };
  });
  assert.equal(
    (await f.run({ enabled_mcp_tools: { [keys.approved]: true } })).status,
    409,
  );
  assert.equal(f.calls.length, 1);
});

test("F041 concurrent menu choices serialize and account bootstrap waits for completion", async () => {
  const f = fixture(),
    keys = permissionKeys(f.server, f.server.toolList![0]);
  let release!: () => void, began!: () => void;
  const started = new Promise<void>((r) => (began = r)),
    delay = new Promise<void>((r) => (release = r));
  let writes = 0;
  f.answer(async (name, changes) => {
    if (name === "mcpServers") return { servers: [f.server] };
    if (++writes === 1) {
      began();
      await delay;
    }
    f.config().wiki = {
      url: f.server.url,
      disabled_tools: changes[0].permission === "block" ? ["lookup"] : [],
      tools: {
        lookup: {
          approval_mode:
            changes[0].permission === "allow" ? "approve" : "prompt",
        },
      },
    };
    return { servers: [f.server] };
  });
  const first = f.run({ enabled_mcp_tools: { [keys.enabled]: false } });
  await started;
  const second = f.run({
    enabled_mcp_tools: { [keys.enabled]: true, [keys.approved]: true },
  });
  let readDone = false;
  const read = inAdapterScope(f.scope, async () => {
    await waitForConnectorToolChanges();
    readDone = true;
    return connectorToolSettings();
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(writes, 1);
  assert.equal(readDone, false);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await read)[keys.approved], true);
  assert.equal(writes, 2);
});

for (const change of ["remove", "replace", "policy", "disable"] as const)
  test(`F041 same-account ${change} invalidates cached session tool settings`, async () => {
    const f = fixture(),
      keys = permissionKeys(f.server, f.server.toolList![0]);
    await f.methods.replaceRemoteMcpServers("one", [
      { uuid: connectorUuid("wiki") },
    ]);
    assert.equal(
      (await f.methods.getEnabledMcpTools("one"))[keys.enabled],
      true,
    );
    if (change === "remove") f.replaceConfig({});
    else if (change === "replace")
      f.config().wiki.url = "https://replacement.test/mcp";
    else if (change === "disable") f.config().wiki.enabled = false;
    else f.config().wiki.disabled_tools = ["lookup"];
    assert.notEqual(
      (await f.methods.getEnabledMcpTools("one"))[keys.enabled],
      true,
    );
  });

for (const failure of ["config-error", "configuration", "activation"] as const)
  test(`F041 session ${failure} discovery cannot persist a selection`, async () => {
    const f = fixture();
    f.answer(async (name) => {
      assert.equal(name, "mcpServers");
      if (failure === "configuration")
        f.config().wiki.url = "https://replacement.test/mcp";
      if (failure === "activation") f.retire();
      return {
        servers: [f.server],
        ...(failure === "config-error" ? { configError: "invalid" } : {}),
      };
    });
    await assert.rejects(
      f.methods.setMcpServers("one", [
        { uuid: connectorUuid("wiki"), enabled: false },
      ]),
      /changed|not available/,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.conversation().connectorOverrides, undefined);
  });
