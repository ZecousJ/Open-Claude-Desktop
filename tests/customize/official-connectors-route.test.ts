import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  connectorUuid,
  connectorsRoute,
  connectorToolSettings,
} from "../../electron/official-ui/api/connectors";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";
import { bootstrapRoute } from "../../electron/official-ui/api/bootstrap";
import { organizationUuid } from "../../electron/official-ui/api/context";

test("connector removal retries a restarting engine and removes the matching server", async () => {
  let reads = 0, removed = false;
  const owner = "connector-owner";
  const calls: string[] = [];
  const context = {
    account: () => ({ id: owner }),
    async call(name: string, ...args: unknown[]) {
      calls.push(name);
      if (name === "mcpServers") {
        if (++reads === 1) throw new Error("engine is not connected");
        return {
          servers: removed ? [] : [{ name: "test-server", url: "https://example.com/mcp" }],
        };
      }
      if (name === "removeConnector") {
        assert.equal(args[0], "test-server");
        removed = true;
      }
    },
  };
  const server = http.createServer((req, res) => {
    void connectorsRoute(req, res, req.url!, context as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${port}/api/organizations/${organizationUuid(owner)}/mcp/remote_servers/${connectorUuid("test-server")}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 204);
    assert.deepEqual(calls, ["mcpServers", "mcpServers", "removeConnector", "mcpServers"]);
  } finally {
    server.close();
  }
});

test("navigation waits for the whole tool-policy commit and preserves disabled definitions", async () => {
  const scope = newAdapterScope("navigation-tools");
  const tools = ["one", "two", "three"].map((name) => ({
    name,
    description: `Definition ${name}`,
    enabled: true,
  }));
  let configured: Record<string, unknown> = {
    wiki: { url: "https://example.test/mcp" },
  };
  let release!: () => void, began!: () => void;
  const started = new Promise<void>((resolve) => (began = resolve));
  const delayed = new Promise<void>((resolve) => (release = resolve));
  let commits = 0;
  const ctx = {
    root: "/not-a-recorded-bundle",
    sessionIdentity: () => scope,
    account: () => ({ id: "navigation-tools", name: "Test" }),
    settings: () => ({ mcpServers: configured }),
    async call(name: string, changes: any[]) {
      if (name === "setConnectorToolPermissions") {
        commits++;
        assert.equal(changes.length, 3);
        configured = {
          wiki: {
            url: "https://example.test/mcp",
            disabled_tools: changes.map((c) => c.tool),
          },
        };
        began();
        await delayed;
        // Like a restart-invalidated discovery response, the write committed.
        throw Error("The Codex engine is not connected.");
      }
      if (name === "mcpServers")
        return {
          servers: [
            {
              name: "wiki",
              url: "https://example.test/mcp",
              state: "ready",
              toolList: commits
                ? tools.map((t) => ({ ...t, description: "", enabled: false }))
                : tools,
            },
          ],
        };
      if (name === "memoryStatus") return undefined;
      throw Error(`Unexpected call ${name}`);
    },
  };
  const server = http.createServer(
    (req, res) =>
      void inAdapterScope(scope, async () => {
        if (await bootstrapRoute(req, res, req.url!, ctx as never)) return;
        await connectorsRoute(req, res, req.url!, ctx as never);
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const keys = tools.map((t) => `${connectorUuid("wiki")}:${t.name}`);
  try {
    const patch = fetch(`${origin}/api/account/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled_mcp_tools: Object.fromEntries(keys.map((k) => [k, false])),
      }),
    });
    await started;
    let readDone = false;
    const read = fetch(`${origin}/api/account`).then(async (r) => {
      readDone = true;
      return r.json();
    });
    // Flush the independent HTTP read while the real mutation stays pending.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      readDone,
      false,
      "account bootstrap must wait, not capture a stale permission map",
    );
    release();
    assert.equal((await patch).status, 200);
    const account = await read;
    assert.deepEqual(
      keys.map((k) => account.settings.enabled_mcp_tools[k]),
      [false, false, false],
    );
    assert.equal(
      commits,
      1,
      "a committed mutation must not be retried after restart",
    );
    const stream = await (await fetch(`${origin}/mcp/v2/bootstrap`)).text();
    for (const tool of tools) assert.ok(stream.includes(tool.description));
    const result = JSON.parse(
      /event: tools\ndata: (.*)/.exec(stream)![1],
    ).tools;
    assert.equal(result.length, 3, "disabled connector can be enabled again");
  } finally {
    release();
    server.close();
  }
});

test("a successful native response containing only part of a menu choice is not acknowledged as saved", async () => {
  const scope = newAdapterScope("partial-native-tool-response");
  const tools = ["one", "two"].map(name => ({ name, description: name, enabled: true }));
  const state = (toolList: typeof tools) => ({ servers: [{ name: "wiki", url: "https://example.test/mcp", toolList }] });
  const server = http.createServer((req, res) => void inAdapterScope(scope, () => connectorsRoute(req, res, req.url!, {
    async call(name: string) {
      if (name === "mcpServers") return state(tools);
      if (name === "setConnectorToolPermissions") return state([{ ...tools[0], enabled: false }, tools[1]]);
      throw Error(`Unexpected call ${name}`);
    },
  } as never)));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/account/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled_mcp_tools: Object.fromEntries(tools.map(t=>[`${connectorUuid("wiki")}:${t.name}`, false])) }) });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /not saved completely/);
  } finally { server.close(); }
});

test("the official account tool controls update engine policy and preserve account isolation", async () => {
  const scopes = { a: newAdapterScope("a"), b: newAdapterScope("b") };
  const state = {
    a: { enabled: true, approval: "ask" },
    b: { enabled: true, approval: "ask" },
  };
  const uuid = connectorUuid("test-server");
  const enabled = `${uuid}:lookup`;
  const approved = `${enabled}-${createHash("md5")
    .update(JSON.stringify(["Find a fact", [], null]))
    .digest("hex")}`;
  const writes: unknown[][] = [];
  const server = http.createServer((req, res) => {
    const owner = req.headers["x-test-account"] === "b" ? "b" : "a";
    void inAdapterScope(scopes[owner], () =>
      connectorsRoute(req, res, req.url!, {
        async call(method: string, ...args: unknown[]) {
          if (method === "mcpServers")
            return {
              servers: [
                {
                  name: "test-server",
                  url: "https://example.com/mcp",
                  state: "ready",
                  toolList: [
                    {
                      name: "lookup",
                      description: "Find a fact",
                      ...state[owner],
                    },
                  ],
                },
              ],
            };
          if (method === "setConnectorToolPermissions") {
            const [change] = args[0] as {
              name: string;
              tool: string;
              permission: string;
            }[];
            writes.push([owner, change.name, change.tool, change.permission]);
            state[owner] = {
              enabled: change.permission !== "block",
              approval: change.permission === "allow" ? "approve" : "ask",
            };
          }
        },
      } as never),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const patch = (changes: unknown) =>
      fetch(`${base}/api/account/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled_mcp_tools: changes }),
      });
    assert.equal((await patch({ [enabled]: false })).status, 200);
    assert.equal(state.a.enabled, false);
    const bootstrap = await fetch(`${base}/mcp/v2/bootstrap`);
    const stream = await bootstrap.text();
    assert.match(
      stream,
      /lookup/,
      "disabled tools must remain available to turn back on",
    );
    const tools = JSON.parse(/event: tools\ndata: (.*)/.exec(stream)![1]).tools;
    assert.equal(
      tools[0].enabled_key,
      enabled,
      "official controls consume the served key",
    );
    assert.equal(tools[0].always_approved_key, approved);
    assert.deepEqual(tools[0].inputSchema, { type: "object" });
    assert.equal(
      (await patch({ [enabled]: true, [approved]: true })).status,
      200,
    );
    assert.equal(state.a.approval, "approve");
    assert.equal((await patch({ [approved]: false })).status, 200);
    assert.equal(state.a.approval, "ask");
    assert.equal((await patch({ "other-account:lookup": false })).status, 400);
    assert.equal(writes.length, 3, "unknown keys must not reach the engine");
    await fetch(`${base}/mcp/v2/bootstrap`, {
      headers: { "x-test-account": "b" },
    });
    assert.equal(
      inAdapterScope(scopes.a, () => connectorToolSettings()[approved]),
      false,
    );
    assert.equal(
      inAdapterScope(scopes.b, () => connectorToolSettings()[enabled]),
      true,
    );
  } finally {
    server.close();
  }
});

test("connector consent receipts belong to the account and disappear on removal", async () => {
  const scopes = {
    a: newAdapterScope("consent-a"),
    b: newAdapterScope("consent-b"),
  };
  const uuid = connectorUuid("consent-server");
  const server = http.createServer((req, res) => {
    const owner = req.headers["x-test-account"] === "b" ? "b" : "a";
    void inAdapterScope(scopes[owner], () =>
      connectorsRoute(req, res, req.url!, {
        call: async (method: string) =>
          method === "mcpServers"
            ? {
                servers: [
                  { name: "consent-server", url: "https://example.com/mcp" },
                ],
              }
            : undefined,
      } as never),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (suffix: string, method = "POST", owner = "a") =>
      fetch(`${origin}/api/accounts/me/consents${suffix}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-test-account": owner,
        },
        body: JSON.stringify({
          consent_type: "consumer_health",
          entity_type: "mcp_remote_server",
          entity_id: uuid,
          consent_hash: "shown-copy-hash",
        }),
      });
    assert.equal((await (await request("/check")).json()).has_consent, false);
    assert.equal((await request("", "PUT")).status, 204);
    assert.equal((await (await request("/check")).json()).has_consent, true);
    assert.equal(
      (await (await request("/check", "POST", "b")).json()).has_consent,
      false,
    );
    await fetch(`${origin}/mcp/remote_servers/${uuid}`, { method: "DELETE" });
    assert.equal((await (await request("/check")).json()).has_consent, false);
  } finally {
    server.close();
  }
});

test("connector lookup errors are not reported as a missing connector", async () => {
  const server = http.createServer((req, res) => {
    void connectorsRoute(req, res, req.url!, {
      call: async () => {
        throw new Error("status unavailable");
      },
    } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/remote_servers/${connectorUuid("test-server")}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 400);
    assert.match(await response.text(), /status unavailable/);
  } finally {
    server.close();
  }
});

test("a tool policy mutation is not repeated after it restarts the engine", async () => {
  let changed = false;
  let mutations = 0;
  const server = http.createServer((req, res) => {
    void connectorsRoute(req, res, req.url!, {
      async call(name: string) {
        if (name === "mcpServers")
          return {
            servers: [
              {
                name: "test-server",
                url: "https://example.com/mcp",
                toolList: [{ name: "lookup", enabled: !changed }],
              },
            ],
          };
        if (name === "setConnectorToolPermission") {
          mutations++;
          changed = true;
          throw new Error("The Codex engine is not connected.");
        }
      },
    } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/remote_servers/${connectorUuid("test-server")}/tool_policies`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policies: [{ tool_name: "lookup", policy: "disabled" }],
        }),
      },
    );
    assert.equal(response.status, 204);
    assert.equal(mutations, 1);
  } finally {
    server.close();
  }
});

test("removal succeeds after a restart only when the server is actually gone", async () => {
  let removed = false;
  let mutations = 0;
  const server = http.createServer((req, res) => {
    void connectorsRoute(req, res, req.url!, {
      async call(name: string) {
        if (name === "mcpServers")
          return {
            servers: removed
              ? []
              : [{ name: "test-server", url: "https://example.com/mcp" }],
          };
        if (name === "removeConnector") {
          mutations++;
          removed = true;
          throw new Error("The Codex engine is not connected.");
        }
      },
    } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/remote_servers/${connectorUuid("test-server")}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 204);
    assert.equal(mutations, 1);
  } finally {
    server.close();
  }
});

test("connector creation and deletion reconcile their committed configuration after a runtime replacement", async () => {
  let config: Record<string, unknown> = {};
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    void connectorsRoute(req, res, req.url!, {
      settings: () => ({ mcpServers: config }),
      async call(name: string, input: any) {
        calls.push(name);
        if (name === "addCustomConnector")
          config = { test: { url: input.url, display_name: input.name } };
        else if (name === "removeConnector") config = {};
        else throw Error(`Unexpected read: ${name}`);
        throw Error(
          "This connector operation belongs to a retired account or connector. Open it again.",
        );
      },
    } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/remote_servers`;
  try {
    const added = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test", url: "https://example.test/mcp" }),
    });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).uuid, connectorUuid("test"));
    assert.equal(
      (await fetch(`${base}/${connectorUuid("test")}`, { method: "DELETE" }))
        .status,
      204,
    );
    assert.deepEqual(config, {});
    assert.deepEqual(calls, ["addCustomConnector", "removeConnector"]);
  } finally {
    server.close();
  }
});

test("a failed connector creation cannot claim success from a different server at the same URL", async () => {
  const server = http.createServer((req, res) => {
    void connectorsRoute(req, res, req.url!, {
      settings: () => ({
        mcpServers: {
          existing: {
            url: "https://example.test/mcp",
            display_name: "Existing",
          },
        },
      }),
      async call() {
        throw Error("The Codex engine is not connected.");
      },
    } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/remote_servers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Another",
          url: "https://example.test/mcp",
        }),
      },
    );
    assert.equal(response.status, 400);
  } finally {
    server.close();
  }
});
