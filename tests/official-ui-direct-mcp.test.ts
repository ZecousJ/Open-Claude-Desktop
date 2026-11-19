import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, type MessagePort as WorkerPort } from "node:worker_threads";
import type { MessagePortMain } from "electron";
import { z } from "zod";
import { createDirectMcpBridge } from "../electron/official-ui/native/direct-mcp";

const messageMap = z.record(z.string(), z.unknown());

class TestPort extends EventEmitter implements MessagePortMain {
  constructor(private readonly port: WorkerPort) {
    super();
    port.on("message", (data) => this.emit("message", { data }));
    port.on("close", () => this.emit("close"));
  }
  close() {
    this.port.close();
  }
  postMessage(message: unknown) {
    this.port.postMessage(message);
  }
  start() {
    this.port.start();
  }
}

function message(port: TestPort, predicate: (value: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      port.off("message", receive);
      reject(Error(`Timed out waiting for MCP message: ${predicate.toString()}`));
    }, 5000);
    const receive = (event: Electron.MessageEvent) => {
      const value: unknown = event.data;
      const parsed = messageMap.safeParse(value);
      if (!parsed.success) return;
      const record = parsed.data;
      if (!predicate(record)) return;
      clearTimeout(timer);
      port.off("message", receive);
      resolve(record);
    };
    port.on("message", receive);
  });
}

async function waitForProcessExit(pidFile: string) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(pidFile), true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("MCP server process did not exit after its port retired.");
}

test("the official MCP port bridges a persistent stdio session in both directions", { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-direct-mcp-"));
  const stoppedFile = path.join(directory, "stopped");
  const pidFile = path.join(directory, "pid");
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
process.on('SIGTERM', () => { fs.writeFileSync(process.env.STOPPED_FILE, 'stopped'); process.exit(0); });
input.on('line', raw => {
  const message = JSON.parse(raw);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'synthetic', version: '1' } } });
  else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    send({ jsonrpc: '2.0', id: 'server-request', method: 'roots/list', params: {} });
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'hello', inputSchema: { type: 'object' } }] } });
  } else if (message.id === 'server-request' && message.result) {
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'client response received' } });
  } else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: message.params.name }] } });
  else if (message.method === 'resources/list') send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'fixture://one', name: 'one' }] } });
  else if (message.method === 'resources/read') send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: 'fixture://one', text: 'resource body' }] } });
  else if (message.method === 'test/hang') send({ jsonrpc: '2.0', method: 'test/received' });
});
`;
  let active = true;
  let config: Record<string, unknown> = {
    fixture: {
      command: process.execPath,
      args: ["-e", script],
      env: { PID_FILE: pidFile, STOPPED_FILE: stoppedFile },
    },
    disabled: { command: process.execPath, enabled: false },
    remote: { url: "https://example.test/mcp" },
    malformed: { command: 42 },
  };
  const bridge = createDirectMcpBridge({
    mcpConfig: () => JSON.stringify(config),
    isCurrent: () => active,
  });
  const channel = new MessageChannel();
  const hostPort = new TestPort(channel.port1);
  const clientPort = new TestPort(channel.port2);
  try {
    assert.deepEqual(bridge.list(), ["fixture"]);
    assert.throws(() => bridge.connect("disabled", hostPort), /unavailable/);
    const uuid = bridge.connect("fixture", hostPort);
    assert.match(uuid, /^[0-9a-f-]{36}$/);
    clientPort.start();

    const initialized = message(clientPort, (value) => value.id === 1);
    clientPort.postMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } } });
    assert.deepEqual(await initialized, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "synthetic", version: "1" },
      },
    });

    clientPort.postMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listChanged = message(clientPort, (value) => value.method === "notifications/tools/list_changed");
    const serverRequestPromise = message(clientPort, (value) => value.method === "roots/list");
    const toolsList = message(clientPort, (value) => value.id === 2);
    clientPort.postMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal((await listChanged).method, "notifications/tools/list_changed");
    const serverRequest = await serverRequestPromise;
    assert.equal(serverRequest.id, "server-request");
    const serverNotification = message(clientPort, (value) => value.method === "notifications/message");
    clientPort.postMessage({ jsonrpc: "2.0", id: "server-request", result: { roots: [] } });
    assert.equal((await serverNotification).method, "notifications/message");
    assert.deepEqual(await toolsList, {
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "hello", inputSchema: { type: "object" } }] },
    });

    const toolCall = message(clientPort, (value) => value.id === 3);
    clientPort.postMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hello", arguments: {} } });
    assert.deepEqual(await toolCall, {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "hello" }] },
    });
    const resourceList = message(clientPort, (value) => value.id === 4);
    clientPort.postMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    assert.deepEqual(await resourceList, {
      jsonrpc: "2.0",
      id: 4,
      result: { resources: [{ uri: "fixture://one", name: "one" }] },
    });
    const resourceRead = message(clientPort, (value) => value.id === 5);
    clientPort.postMessage({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "fixture://one" } });
    assert.deepEqual(await resourceRead, {
      jsonrpc: "2.0",
      id: 5,
      result: { contents: [{ uri: "fixture://one", text: "resource body" }] },
    });

    const pendingResponse = message(clientPort, (value) => value.id === "pending");
    const pendingReceived = message(clientPort, (value) => value.method === "test/received");
    clientPort.postMessage({ jsonrpc: "2.0", id: "pending", method: "test/hang" });
    await pendingReceived;
    bridge.retireServer("fixture");
    assert.deepEqual(await pendingResponse, {
      jsonrpc: "2.0",
      id: "pending",
      error: { code: -32000, message: "MCP server configuration changed." },
    });
    await waitForProcessExit(pidFile);
    assert.equal(fs.existsSync(stoppedFile), true);

    config = { fixture: { command: process.execPath, enabled: false } };
    assert.deepEqual(bridge.list(), []);
    active = false;
    assert.throws(() => bridge.list(), /retired/);
  } finally {
    active = false;
    bridge.dispose();
    hostPort.close();
    clientPort.close();
    if (fs.existsSync(pidFile)) await waitForProcessExit(pidFile);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
