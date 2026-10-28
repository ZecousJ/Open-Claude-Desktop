import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  customConnectorEntry,
  McpConfigFile,
  mcpServerStates,
  withToolEnabled,
} from "../../electron/connectors/mcp-config-file";

test("custom connectors need a name and an https (or local http) address", () => {
  assert.deepEqual(
    customConnectorEntry({ name: "docs", url: "https://example.com/mcp" }, {}),
    ["docs", { url: "https://example.com/mcp" }],
  );
  assert.deepEqual(
    customConnectorEntry(
      {
        name: "local",
        url: "http://127.0.0.1:8080/mcp",
        bearerTokenEnvVar: "MY_TOKEN",
      },
      {},
    ),
    [
      "local",
      { url: "http://127.0.0.1:8080/mcp", bearer_token_env_var: "MY_TOKEN" },
    ],
  );
  assert.throws(
    () => customConnectorEntry({ name: "x", url: "http://example.com" }, {}),
    /https/,
  );
  assert.throws(
    () =>
      customConnectorEntry(
        { name: "x", url: "https://user:pw@example.com" },
        {},
      ),
    /https/,
  );
  assert.throws(
    () => customConnectorEntry({ name: "bad name", url: "https://a.b" }, {}),
    /letters, numbers/i,
  );
  assert.throws(
    () =>
      customConnectorEntry({ name: "docs", url: "https://a.b" }, { docs: {} }),
    /exists/,
  );
  assert.throws(
    () => customConnectorEntry({ name: "x", url: "not a url" }, {}),
    /full address/,
  );
  // A token variable that is not text is ignored, not a crash.
  assert.deepEqual(
    customConnectorEntry(
      {
        name: "odd",
        url: "https://a.b/mcp",
        bearerTokenEnvVar: 42 as unknown as string,
      },
      {},
    ),
    ["odd", { url: "https://a.b/mcp" }],
  );
  // The gateway token must never be handed to a connector.
  for (const variable of [
    "CLAUDEX_GATEWAY_TOKEN",
    "claudex_x",
    "OPENAI_API_KEY",
  ])
    assert.throws(
      () =>
        customConnectorEntry(
          { name: "x", url: "https://a.b", bearerTokenEnvVar: variable },
          {},
        ),
      /reserved/,
    );
  assert.throws(
    () =>
      customConnectorEntry(
        { name: "x", url: "https://a.b", bearerTokenEnvVar: "1 BAD" },
        {},
      ),
    /environment variable/,
  );
});

test("tools are switched off through disabled_tools", () => {
  const off = withToolEnabled({ url: "https://a.b" }, "delete", false);
  assert.deepEqual(off, { url: "https://a.b", disabled_tools: ["delete"] });
  assert.deepEqual(withToolEnabled(off, "delete", false), off);
  assert.deepEqual(withToolEnabled(off, "delete", true), {
    url: "https://a.b",
  });
});

test("server states list tools, switched-off ones and the sign-in state", () => {
  const [state] = mcpServerStates(
    { docs: { url: "https://a.b", disabled_tools: ["write"] } },
    true,
    new Map(),
    [
      {
        name: "docs",
        authStatus: "notLoggedIn",
        tools: {
          search: { name: "search", description: "Find pages" },
          read: { name: "read" },
        },
      },
    ],
  );
  assert.equal(state.authStatus, "notLoggedIn");
  assert.deepEqual(state.toolList, [
    { name: "read", description: "", enabled: true },
    { name: "search", description: "Find pages", enabled: true },
    { name: "write", description: "", enabled: false },
  ]);
  const [unknown] = mcpServerStates(
    { docs: { url: "https://a.b" } },
    true,
    new Map(),
    [{ name: "docs", authStatus: "weird" }],
  );
  assert.equal(unknown.authStatus, undefined);
});

test("Settings changes go through the same policy check as the file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let servers: Record<string, unknown> = {};
  let refuse = false;
  const file: McpConfigFile = new McpConfigFile(
    root,
    () => servers,
    (next) => {
      if (refuse)
        file.error = "Your administrator has turned off adding MCP servers.";
      else servers = next;
    },
  );
  file.update({ docs: { url: "https://a.b" } });
  assert.deepEqual(servers, { docs: { url: "https://a.b" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file.path, "utf8")), {
    mcpServers: { docs: { url: "https://a.b" } },
  });
  refuse = true;
  assert.throws(() => file.update({}), /turned off/);
  assert.equal(file.error, undefined);
  assert.deepEqual(servers, { docs: { url: "https://a.b" } });
  assert.throws(
    () => file.update({ "bad name": { url: "x" } }),
    /valid server name/,
  );
});
