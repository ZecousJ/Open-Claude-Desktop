import test from "node:test";
import assert from "node:assert/strict";
import { openPolicy, pendingPolicy } from "../../shared/client-policy";
import {
  availableProjectTools,
  connectorThreadConfig,
  projectConnectorOverrides,
  recommendedProjectTools,
  updateProjectTools,
} from "../../shared/project-tools";
import { projectToolsInput } from "../../shared/project-tools-input";

test("project tools include supported builtins and configured, allowed connectors in name order", () => {
  const servers = {
    Zebra: { command: "server" },
    Alpha: { url: "https://example.com/mcp", enabled: false },
    Hidden: { command: "hidden" },
    invalid: null,
  };
  const policy = {
    ...openPolicy,
    connectors: [{ name: "Alpha" }, { name: "Zebra" }],
  };
  assert.deepEqual(
    availableProjectTools(policy, servers).map((tool) => tool.id),
    ["builtin:web-search", "builtin:research", "mcp:Alpha", "mcp:Zebra"],
  );
  assert.deepEqual(
    availableProjectTools(
      { ...pendingPolicy, webSearch: false, connectors: [] },
      servers,
    ),
    [],
  );
  assert.deepEqual(
    availableProjectTools(
      { ...policy, research: { ...policy.research!, enabled: false } },
      {},
    ).map((tool) => tool.id),
    ["builtin:web-search"],
  );
});

test("saving recommendations changes only chosen and explicitly removed tools, keeping unavailable recommendations", () => {
  const tools = availableProjectTools(openPolicy, {
    Alpha: { command: "server" },
    Beta: { command: "server" },
  });
  const saved = projectToolsInput.parse({
    webSearch: true,
    research: true,
    connectors: ["Alpha", "missing"],
  });
  assert.deepEqual(recommendedProjectTools(saved), [
    "builtin:web-search",
    "builtin:research",
    "mcp:Alpha",
    "mcp:missing",
  ]);
  assert.deepEqual(
    updateProjectTools(
      saved,
      tools,
      ["builtin:research", "mcp:Beta"],
      new Set(["builtin:web-search", "mcp:Alpha"]),
    ),
    { webSearch: false, research: true, connectors: ["missing", "Beta"] },
  );
  assert.deepEqual(updateProjectTools(saved, tools, [], new Set()), saved);
});

test("connector recommendations enable all tools per thread without mutating global configuration or bypassing filtered servers", () => {
  const servers = {
    Alpha: { command: "server", enabled: false, disabled_tools: ["read"] },
    Beta: { command: "server" },
  };
  const overrides = projectConnectorOverrides({
    id: "p",
    name: "p",
    description: "",
    instructions: "",
    createdAt: 1,
    tools: { connectors: ["Alpha", "removed"] },
  });
  assert.deepEqual(
    connectorThreadConfig(servers, { ...overrides, Beta: false }),
    {
      "mcp_servers.Alpha.enabled": true,
      "mcp_servers.Beta.enabled": false,
    },
  );
  assert.deepEqual(servers.Alpha, {
    command: "server",
    enabled: false,
    disabled_tools: ["read"],
  });
  assert.deepEqual(connectorThreadConfig({}, overrides), {});
});
