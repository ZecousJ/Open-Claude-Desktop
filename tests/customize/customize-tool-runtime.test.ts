import { registerConversationHandlers } from "../../electron/ipc/conversations";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectorThreadConfig } from "../../shared/project-tools";
import { connectorToolOverridesInput } from "../../shared/project-tools-input";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import {
  CodexHost,
  MockResponses,
  reachableTools,
  toolPlan,
} from "../spikes/harness";
import { McpHttpServer } from "../spikes/mcp-http-server";

test("conversation tool switches preserve globally disabled tools and never create absent servers", () => {
  assert.deepEqual(
    connectorThreadConfig({ docs: { disabled_tools: ["admin"] } }, undefined, {
      docs: { admin: true, read: false, write: true },
      absent: { unsafe: true },
    }),
    { "mcp_servers.docs.disabled_tools": ["admin", "read"] },
  );
  assert.throws(() =>
    connectorToolOverridesInput.parse({ "unsafe.name": { read: true } }),
  );
  assert.throws(() =>
    connectorToolOverridesInput.parse({ docs: { read: "true" } }),
  );
});

test("the real Engine isolates tool choices and reloads an already loaded conversation before its next turn", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b34-thread-tools-"),
  );
  const store = new Store(root);
  store.settings.mcpServers = {
    docs: { command: "docs", disabled_tools: ["admin"] },
  };
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  const calls: { method: string; params: any }[] = [];
  engine.rpc = {
    async stop() {},
    async call(method: string, params: any) {
      calls.push({ method, params: structuredClone(params) });
      return method === "thread/start"
        ? { thread: { id: `thread-${calls.length}` } }
        : method === "turn/start"
          ? { turn: { id: `turn-${calls.length}` } }
          : {};
    },
  } as never;
  t.after(async () => {
    await engine.stop();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = {
    text: "synthetic",
    mode: "chat" as const,
    attachments: [],
    providerId: store.settings.providers[0].id,
    model: "synthetic-model",
  };
  const first = await engine.send({
    ...input,
    connectorToolOverrides: { docs: { read: false, admin: true } },
  });
  store.conversation(first.id).turns.at(-1)!.status = "completed";
  const firstThread = calls.find((call) => call.method === "thread/start")!;
  assert.deepEqual(
    firstThread.params.config["mcp_servers.docs.disabled_tools"],
    ["admin", "read"],
  );
  const second = await engine.send(input);
  store.conversation(second.id).turns.at(-1)!.status = "completed";
  const otherThread = calls.filter((call) => call.method === "thread/start")[1];
  assert.equal(
    otherThread.params.config["mcp_servers.docs.disabled_tools"],
    undefined,
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  registerConversationHandlers((name, fn) => handlers.set(name, fn), {
    store,
    engine,
    replyFeedback: {} as never,
    selectedAttachments: new Map(),
    allowedFolder() {},
    noActive() {},
  });
  await handlers.get("updateConversation")!(first.id, {
    connectorOverrides: { docs: true },
    connectorToolOverrides: { docs: { write: false } },
  });
  assert.equal(store.conversation(first.id).connectorOverrides?.docs, true);
  assert.equal(
    new Store(root).conversation(first.id).connectorOverrides?.docs,
    true,
  );
  const committed = structuredClone(
    store.conversation(first.id).connectorToolOverrides,
  );
  const write = store.write.bind(store);
  store.write = () => {
    throw Error("Synthetic durable tool save failure");
  };
  try {
    await assert.rejects(
      async () =>
        handlers.get("updateConversation")!(first.id, {
          connectorOverrides: { docs: false },
          connectorToolOverrides: { docs: { read: false } },
        }),
      /durable tool save failure/,
    );
  } finally {
    store.write = write;
  }
  assert.deepEqual(
    store.conversation(first.id).connectorToolOverrides,
    committed,
  );
  assert.equal(store.conversation(first.id).connectorOverrides?.docs, true);
  store.conversation(first.id).incognito = true;
  await assert.rejects(
    async () =>
      handlers.get("updateConversation")!(first.id, {
        connectorToolOverrides: { docs: { read: false } },
      }),
    /new incognito chat/,
  );
  store.conversation(first.id).incognito = false;
  await engine.send({ ...input, conversationId: first.id });
  store.conversation(first.id).turns.at(-1)!.status = "completed";
  const resume = [...calls]
    .reverse()
    .find((call) => call.method === "thread/resume")!;
  assert.equal(resume.params.threadId, first.threadId);
  assert.deepEqual(resume.params.config["mcp_servers.docs.disabled_tools"], [
    "admin",
    "write",
  ]);
  assert.deepEqual(store.settings.mcpServers.docs, {
    command: "docs",
    disabled_tools: ["admin"],
  });
});

test("installed Codex enforces disabled_tools independently for two real thread/start calls", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b34-real-tool-policy-"),
  );
  const mock = await new MockResponses().start();
  const mcp = await new McpHttpServer("synthetic-token").start();
  const host = new CodexHost(
    path.join(root, "home"),
    mock,
    {},
    { SPIKE_PROBE_TOKEN: "synthetic-token" },
  );
  t.after(async () => {
    await host.stop();
    await mcp.close();
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await host.start();
  const config = {
    "mcp_servers.probe.url": mcp.url,
    "mcp_servers.probe.bearer_token_env_var": "SPIKE_PROBE_TOKEN",
    "mcp_servers.probe.default_tools_approval_mode": "approve",
  };
  const disabled = await host.thread("grok-4", path.join(root, "workspace"), {
    config: { ...config, "mcp_servers.probe.disabled_tools": ["probe_echo"] },
  });
  mock.script = toolPlan([{ suffix: "probe_echo", args: { text: "blocked" } }]);
  await host.turn(disabled, "Use probe_echo if it is available.");
  assert.ok(
    !host.mock
      .forThread(disabled)
      .flatMap(reachableTools)
      .some((name) => name.endsWith("probe_echo")),
  );
  assert.ok(
    !mcp.log.some(
      (item) =>
        item.method === "tools/call" && item.params?.name === "probe_echo",
    ),
  );
  const enabled = await host.thread("grok-4", path.join(root, "workspace"), {
    config,
  });
  mock.script = toolPlan([{ suffix: "probe_echo", args: { text: "enabled" } }]);
  await host.turn(enabled, "Use probe_echo.");
  assert.ok(
    host.mock
      .forThread(enabled)
      .flatMap(reachableTools)
      .some((name) => name.endsWith("probe_echo")),
  );
  assert.ok(
    mcp.log.some(
      (item) =>
        item.method === "tools/call" && item.params?.name === "probe_echo",
    ),
  );
});
