import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { McpLogsDialog } from "../../src/settings/McpLogsDialog";
import { AppContext } from "../../src/app/AppContext";
import { registerMcpSettingsHandlers } from "../../electron/ipc/settings-mcp";
import { McpConnectionLogs } from "../../electron/connectors/mcp-connection-logs";
import { openPolicy } from "../../shared/client-policy";
import type { McpLogSnapshot } from "../../shared/settings-mcp-api";

test("native optional attributed reader stays name/policy gated and absent on unchanged hosted handlers", () => {
  const config = { fixture: { command: "node" } };
  const logs = new McpConnectionLogs(() => config);
  logs.record("fixture", "ready");
  let policy = openPolicy;
  let reads = 0;
  const ctx = {
    store: { root: "/synthetic-owner", settings: { mcpServers: config } },
    engine: { mcpLogs: logs, extensions: { reservedMcpServerNames: () => [] } },
    policy: () => policy,
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerMcpSettingsHandlers(
    ((name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn)) as never,
    ctx as never,
    {
      read(name) {
        reads++;
        assert.equal(name, "fixture");
        return {
          source: "stdio-stderr",
          availability: "available",
          lines: ["private attributed output"],
          truncated: false,
        };
      },
    },
  );
  const first = handlers.get("readMcpLogs")!("fixture") as McpLogSnapshot;
  assert.equal(first.kind, "connection-events");
  assert.equal(first.serverOutput?.source, "stdio-stderr");
  assert.equal(reads, 1);
  assert.throws(() => handlers.get("readMcpLogs")!("../foreign"));
  policy = { ...openPolicy, developerMcpEnabled: false };
  assert.throws(() => handlers.get("readMcpLogs")!("fixture"), /unavailable/);
  assert.equal(reads, 1);
  policy = openPolicy;
  registerMcpSettingsHandlers(
    ((name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn)) as never,
    ctx as never,
  );
  assert.equal(handlers.get("readMcpLogs")!("fixture").serverOutput, undefined);
});

test("mounted dialog distinguishes attributed stderr, pending/unsupported sources and connection events", async () => {
  let availability = "available";
  const env = await routineDom(
    {
      readMcpLogs: async () => ({
        name: "fixture",
        kind: "connection-events",
        lines: ["ready connection event"],
        truncated: false,
        serverOutput: {
          source: "stdio-stderr",
          availability,
          lines: ["attributed [redacted] stderr"],
          truncated: true,
        },
      }),
    } as never,
    { jsdom: true },
  );
  try {
    await env.render(h(McpLogsDialog, { name: "fixture", onClose() {} }));
    assert.match(
      env.document.body.textContent!,
      /Server stderr captured on this computer/,
    );
    assert.equal(
      env.document.querySelector('[aria-label="MCP server stderr"]')!
        .textContent,
      "attributed [redacted] stderr",
    );
    assert.equal(
      env.document.querySelector('[aria-label="MCP connection events"]')!
        .textContent,
      "ready connection event",
    );
    assert.match(env.document.body.textContent!, /most recent server output/);
    const refresh = () =>
      [...env.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Refresh",
      )!;
    availability = "pending";
    await env.event(refresh(), "click");
    assert.match(env.document.body.textContent!, /Waiting for this server/);
    assert.equal(
      env.document.querySelector('[aria-label="MCP server stderr"]'),
      null,
    );
    availability = "unsupported";
    await env.event(refresh(), "click");
    assert.match(
      env.document.body.textContent!,
      /unavailable for this configuration/,
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /attributed \[redacted\] stderr/,
    );
  } finally {
    await env.clean();
  }
});

test("late attributed tail from retired account cannot repaint the mounted dialog", async () => {
  let complete!: (snapshot: McpLogSnapshot) => void;
  const env = await routineDom(
    {
      readMcpLogs: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    } as never,
    { jsdom: true },
  );
  const controller = { accountId: "a", controllerScope: {} };
  const ref = { current: controller };
  const value = { ...controller, currentController: ref };
  try {
    await env.render(
      h(
        AppContext.Provider,
        { value: value as never },
        h(McpLogsDialog, { name: "fixture", onClose() {} }),
      ),
    );
    ref.current = { accountId: "b", controllerScope: {} };
    await act(async () =>
      complete({
        name: "fixture",
        kind: "connection-events",
        lines: [],
        truncated: false,
        serverOutput: {
          source: "stdio-stderr",
          availability: "available",
          lines: ["private retired account output"],
          truncated: false,
        },
      }),
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /private retired account/,
    );
  } finally {
    await env.clean();
  }
});
