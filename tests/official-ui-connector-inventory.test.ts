import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorInventory } from "../electron/official-ui/api/connector-inventory";
import type { AdapterContext } from "../electron/official-ui/api/context";
import type { McpServerState } from "../shared/settings-desktop-api";

test("connector inventory keeps proven host tools across runtime subsets and expires on account or configuration changes", () => {
  let identity = {},
    owner = "one";
  let config = { wiki: { url: "https://example.test/mcp" } } as Record<
    string,
    unknown
  >;
  const context = {
    sessionIdentity: () => identity,
    account: () => ({ id: owner }),
    settings: () => ({ mcpServers: config }),
  } as AdapterContext;
  const server = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    tools: 2,
    toolList: [
      { name: "a", description: "A", enabled: true },
      { name: "b", description: "B", enabled: true },
    ],
  } as McpServerState;
  assert.equal(connectorInventory(context, [server])[0].toolList?.length, 2);
  const subset = { ...server, toolList: [server.toolList![0]] };
  assert.deepEqual(
    connectorInventory(context, [subset])[0].toolList?.map((t) => t.name),
    ["a", "b"],
  );
  config = { wiki: { url: server.url, disabled_tools: ["b"] } };
  const blocked = {
    ...server,
    toolList: [{ ...server.toolList![1], enabled: false }],
  };
  assert.deepEqual(
    connectorInventory(context, [blocked])[0].toolList?.map((t) => [
      t.name,
      t.enabled,
    ]),
    [
      ["a", true],
      ["b", false],
    ],
  );
  const blank = {
    ...blocked,
    toolList: [{ name: "b", description: "", enabled: false }],
  };
  assert.equal(
    connectorInventory(context, [blank])[0].toolList?.find(
      (t) => t.name === "b",
    )?.description,
    "B",
    "blocked placeholder keeps the proven definition and approval fingerprint",
  );
  assert.equal(
    connectorInventory(context, [server])[0].toolList?.find(
      (t) => t.name === "b",
    )?.enabled,
    false,
    "a late live read cannot overwrite the committed policy",
  );
  config = { wiki: { url: "https://different.test/mcp" } };
  assert.equal(
    connectorInventory(context, [subset])[0].toolList?.length,
    1,
    "connection changes discard old definitions",
  );
  owner = "two";
  assert.equal(connectorInventory(context, [subset])[0].toolList?.length, 1);
  owner = "one";
  identity = {};
  assert.equal(connectorInventory(context, [subset])[0].toolList?.length, 1);
  connectorInventory(context, [server]);
  connectorInventory(context, []);
  assert.equal(
    connectorInventory(context, [subset])[0].toolList?.length,
    1,
    "removal discards the old inventory",
  );
});
