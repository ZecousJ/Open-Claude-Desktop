import test from "node:test";
import assert from "node:assert/strict";
import { registerLocalConnectors } from "../electron/official-ui/native/local-connectors";
import { mcpServerStates } from "../electron/connectors/mcp-config-file";

test("an initialized remote connector stays connected with all tools blocked", () => {
  const [server] = mcpServerStates(
    { remote: { url: "https://example.test/mcp", disabled_tools: ["inspect"] } },
    true,
    new Map(),
    [{ name: "remote", tools: {}, authStatus: "unknown", serverInfo: { name: "Fixture", version: "1" } }],
  );
  assert.equal(server.state, "ready");
  assert.equal(server.authStatus, "unsupported");
  assert.equal(server.toolList?.[0].enabled, false);
});
test("official Code and Cowork local lists return connected local definitions, without remote or disabled tools", async () => {
  const definition = {
    name: "inspect",
    description: "Exact definition " + ".".repeat(600),
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    annotations: { readOnlyHint: true },
    _meta: { "test/value": 1 },
  };
  const servers = mcpServerStates(
    {
      local: { command: "node", disabled_tools: ["blocked"] },
      remote: { url: "https://example.test/mcp" },
      off: { command: "node", enabled: false },
    },
    true,
    new Map(),
    [
      {
        name: "local",
        tools: {
          inspect: definition,
          blocked: { name: "blocked", inputSchema: { type: "object" } },
        },
      },
      { name: "remote", tools: {} },
      { name: "off", tools: {} },
    ],
  );
  assert.equal(
    servers[0].toolList?.find((t) => t.name === "inspect")?.definition
      ?.description,
    definition.description,
  );
  const handlers = new Map<string, () => Promise<any>>();
  registerLocalConnectors({
    ctx: { account: () => ({ id: "a" }), localCall: async () => ({ servers }) },
    on: (name: string, fn: any) => handlers.set(name, fn),
  } as never);
  for (const domain of ["LocalSessions", "LocalAgentModeSessions"])
    assert.deepEqual(await handlers.get(domain + ".getLocalMcpServers")!(), [
      { name: "local", serverSource: "user_config", tools: [definition] },
    ]);
});
test("local MCP inventory is rejected when the account changes while awaiting discovery", async () => {
  let account = "a",
    release: any;
  const pending = new Promise((resolve) => (release = resolve)),
    handlers = new Map<string, () => Promise<any>>();
  registerLocalConnectors({
    ctx: { account: () => ({ id: account }), localCall: () => pending },
    on: (name: string, fn: any) => handlers.set(name, fn),
  } as never);
  const result = handlers.get("LocalAgentModeSessions.getLocalMcpServers")!();
  account = "b";
  release({ servers: [] });
  await assert.rejects(result, /account changed/);
});

test("local connector configuration errors are not empty inventory and same-account reactivation retires reads", async () => {
  const handlers = new Map<string, () => Promise<unknown>>();
  let identity = {},
    signedIn = true;
  let answer: () => Promise<unknown> = async () => ({
    servers: [],
    configError: "private path in malformed configuration",
  });
  const ctx = {
    account: () => (signedIn ? { id: "a" } : undefined),
    sessionIdentity: () => identity,
    localCall: () => answer(),
  };
  registerLocalConnectors({
    ctx,
    on: (name: string, fn: any) => handlers.set(name, fn),
  } as never);
  const read = handlers.get("LocalSessions.getLocalMcpServers")!;
  await assert.rejects(read(), /inventory is not available/);
  signedIn = false;
  await assert.rejects(read(), /Sign in/);
  signedIn = true;
  let release!: (value: unknown) => void;
  answer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = read();
  identity = {};
  release({ servers: [] });
  await assert.rejects(pending, /account changed/);
  answer = async () => ({ servers: [] });
  assert.deepEqual(await read(), []);
});
test("local connector host absence rejects rather than claiming an empty installed catalog", async () => {
  const handlers = new Map<string, () => Promise<unknown>>();
  registerLocalConnectors({
    ctx: { account: () => ({ id: "a" }) },
    on: (name: string, fn: any) => handlers.set(name, fn),
  } as never);
  await assert.rejects(
    handlers.get("LocalSessions.getLocalMcpServers")!(),
    /unavailable on this host/,
  );
});
