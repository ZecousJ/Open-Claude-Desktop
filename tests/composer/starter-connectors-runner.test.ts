import test from "node:test";
import assert from "node:assert/strict";
import { openPolicy } from "../../shared/client-policy";
import { starterIntegrations } from "../../shared/starter-integrations";
import {
  customConnectorEntry,
  mcpServerStates,
} from "../../electron/connectors/mcp-config-file";
import { useElectronShim } from "../runner/runner-core-support.test.ts";

useElectronShim();
const { WebMcpConfig } = await import("../../runner/src/web-app-support");

test("the runner persists validated connector identities through the web MCP whitelist", () => {
  const settings = { mcpServers: {} as Record<string, unknown> };
  let changes = 0;
  const ctx = {
    store: { settings, flush() {} },
    policy: () => openPolicy,
    connectorTokens: { keepOnly() {} },
    settingsChanged: () => changes++,
    engineRunning: () => false,
  } as unknown as ConstructorParameters<typeof WebMcpConfig>[0];
  const config = new WebMcpConfig(ctx);
  const [name, entry] = customConnectorEntry(
    {
      name: "mail",
      url: "https://mail.example.test/mcp",
      connectorId: "gmail",
    },
    {},
  );
  config.update({ [name]: { ...entry, command: "/bin/sh" } });
  assert.deepEqual(settings.mcpServers[name], entry);
  assert.equal(changes, 1);
  assert.deepEqual(
    starterIntegrations(
      mcpServerStates(settings.mcpServers, true, new Map(), [
        { name, authStatus: "oAuth", tools: {} },
      ]),
    ),
    ["gmail"],
  );
  config.update({ [name]: { ...entry, connector_id: "unknown" } });
  assert.deepEqual(settings.mcpServers[name], { url: entry.url });
});

test("the runner retains display names and SSE transport but forgets tokens when a URL changes", () => {
  const settings = {
    mcpServers: { example: { url: "https://old.example.com/sse" } } as Record<
      string,
      unknown
    >,
  };
  const forgotten: string[] = [];
  const ctx = {
    store: { settings, flush() {} },
    policy: () => openPolicy,
    connectorTokens: {
      keepOnly() {},
      set(name: string) {
        forgotten.push(name);
      },
    },
    settingsChanged() {},
    engineRunning: () => false,
  } as unknown as ConstructorParameters<typeof WebMcpConfig>[0];
  const entry = {
    url: "https://new.example.com/sse",
    display_name: "My connector",
    claudex_transport: "sse",
  };
  new WebMcpConfig(ctx).update({ example: entry });
  assert.deepEqual(settings.mcpServers.example, entry);
  assert.deepEqual(forgotten, ["example"]);
});
