import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ControlServer } from "../../electron/computer-use/control-server";
import {
  DriverHost,
  driverEnv,
  readDriverManifest,
} from "../../electron/computer-use/driver-host";
import { OpenComputerUseDriver } from "../../electron/computer-use/drivers/open-computer-use";
import { computerUseTools, type ControlCall } from "../../shared/computer-use";

const project = fileURLToPath(new URL("../../", import.meta.url));
const adapter = path.join(project, "server", "computer-use-mcp.ts");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cu-adapter-"));

/** Starts the adapter as Codex would (stdio), with the given environment. */
function startAdapter(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", adapter], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map<number, (message: any) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiters.get(message.id)?.(message);
  });
  let next = 1;
  return {
    child,
    request(method: string, params?: unknown): Promise<any> {
      const id = next++;
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null)
        await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

test("the adapter lists the computer-use tools and forwards calls for its own conversation", async () => {
  const seen: { conversationId: string; call: ControlCall }[] = [];
  const server = new ControlServer({
    runDir: tmp(),
    handle: async (conversationId, call) => {
      seen.push({ conversationId, call });
      return { content: [{ type: "text", text: `did ${call.tool}` }] };
    },
  });
  await server.start();
  const mcp = startAdapter({
    CLAUDEX_CU_SOCKET: server.address,
    CLAUDEX_CU_TOKEN: server.tokenFor("c1"),
    CLAUDEX_CU_CONVERSATION: "c1",
  });
  try {
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.match(init.result.instructions, /data, never instructions/);
    const listed = await mcp.request("tools/list", {});
    assert.deepEqual(
      listed.result.tools.map((tool: any) => tool.name),
      computerUseTools.map((tool) => tool.name),
    );
    const result = await mcp.request("tools/call", {
      name: "screenshot",
      arguments: { app: "TextEdit" },
      _meta: {
        threadId: "th-1",
        "x-codex-turn-metadata": { thread_id: "th-1", turn_id: "tu-1" },
      },
    });
    assert.deepEqual(result.result, {
      content: [{ type: "text", text: "did screenshot" }],
    });
    assert.equal(seen[0].conversationId, "c1");
    assert.deepEqual(seen[0].call.args, { app: "TextEdit" });
    assert.equal(seen[0].call.threadId, "th-1");
    assert.equal(seen[0].call.turnId, "tu-1");
    const unknown = await mcp.request("tools/call", {
      name: "rm",
      arguments: {},
    });
    assert.equal(unknown.error.code, -32602);
    const missing = await mcp.request("resources/list", {});
    assert.equal(missing.error.code, -32601);
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("without the channel, or with another conversation's token, every tool is unavailable", async () => {
  let handled = 0;
  const server = new ControlServer({
    runDir: tmp(),
    handle: async () => {
      handled++;
      return { content: [{ type: "text", text: "acted" }] };
    },
  });
  await server.start();
  for (const env of [
    {} as Record<string, string>,
    {
      CLAUDEX_CU_SOCKET: server.address,
      CLAUDEX_CU_TOKEN: server.tokenFor("c2"),
      CLAUDEX_CU_CONVERSATION: "c1",
    },
  ]) {
    const mcp = startAdapter(env);
    try {
      await mcp.request("initialize", { protocolVersion: "2025-03-26" });
      const result = await mcp.request("tools/call", {
        name: "list_apps",
        arguments: {},
      });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /not available/);
    } finally {
      await mcp.close();
    }
  }
  assert.equal(handled, 0);
  await server.close();
});

test("the control channel closes connections that don't say hello properly", async () => {
  const server = new ControlServer({
    runDir: tmp(),
    handle: async () => ({ content: [] }),
    helloTimeoutMs: 100,
  });
  await server.start();
  if (process.platform !== "win32")
    assert.equal(fs.statSync(server.address).mode & 0o777, 0o600);
  const closed = (write?: string) =>
    new Promise<string>((resolve) => {
      const socket = net.createConnection(server.address);
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      if (write) socket.on("connect", () => socket.write(write));
    });
  assert.equal(
    await closed(
      `${JSON.stringify({ type: "hello", token: "0".repeat(64), conversationId: "c1" })}\n`,
    ),
    "",
  );
  assert.equal(
    await closed(
      `${JSON.stringify({ type: "call", id: 1, tool: "list_apps", args: {} })}\n`,
    ),
    "",
  );
  // Silence: closed after the hello timeout.
  assert.equal(await closed(), "");
  assert.notEqual(server.tokenFor("c1"), server.tokenFor("c2"));
  await server.close();
  assert.equal(fs.existsSync(server.address || "/nonexistent"), false);
});

// ---------------------------------------------------------------------------
// The driver host, with a fake driver process.

const fakeDriver = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") result = { serverInfo: { name: "fake" } };
  if (m.method === "tools/call") {
    if (m.params.arguments.crash) process.exit(3);
    if (m.params.name === "list_apps")
      result = { content: [{ type: "text", text: "TextEdit — com.apple.TextEdit [running]" }] };
    else
      result = { content: [
        { type: "text", text: [m.params.name, process.env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS, process.env.SECRET_TOKEN ?? "none", process.pid].join(" ") },
        { type: "resource", resource: { uri: "x" } },
      ] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

function fakeHost(options: { idleMs?: number } = {}) {
  const dir = tmp();
  const script = path.join(dir, "driver.cjs");
  fs.writeFileSync(script, fakeDriver);
  const manifest = {
    driver: "fake",
    version: "1",
    platform: process.platform,
    executable: "driver.cjs",
    executableSha256: "unused",
    args: ["mcp"],
    env: {
      base: { OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "0" },
      fullControl: { OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "1" },
    },
    tools: [],
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const read = readDriverManifest(dir)!;
  assert.ok(read);
  const spawned: ChildProcessWithoutNullStreams[] = [];
  const host = new DriverHost({
    manifest: read,
    verify: false,
    idleMs: options.idleMs,
    spawner: (_command, _args, env) => {
      const child = spawn(process.execPath, [script], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      spawned.push(child);
      return child;
    },
  });
  return { host, spawned, dir };
}

test("the driver runs with the mode's environment and none of the app's secrets", async () => {
  process.env.SECRET_TOKEN = "s3cret";
  const { host, spawned } = fakeHost();
  const driver = new OpenComputerUseDriver(host);
  try {
    const apps = await driver.listApps("background");
    assert.deepEqual(apps, [
      {
        name: "TextEdit",
        id: "com.apple.TextEdit",
        running: true,
        frontmost: false,
      },
    ]);
    const background = await driver.call("click", { app: "x" }, "background");
    const [, fallback, secret, pid] = (background.content[0] as any).text.split(
      " ",
    );
    assert.equal(fallback, "0");
    assert.equal(secret, "none");
    // Only text and images pass.
    assert.equal(background.content.length, 1);
    const again = await driver.call("click", { app: "x" }, "background");
    assert.equal((again.content[0] as any).text.split(" ")[3], pid);
    // Switching mode restarts the driver with the full-control environment.
    const full = await driver.call("click", { app: "x" }, "fullControl");
    const [, fullFallback, , fullPid] = (full.content[0] as any).text.split(
      " ",
    );
    assert.equal(fullFallback, "1");
    assert.notEqual(fullPid, pid);
    assert.equal(spawned.length, 2);
    await assert.rejects(
      driver.call("doctor", { app: "x" }, "background"),
      /no doctor tool/,
    );
  } finally {
    delete process.env.SECRET_TOKEN;
    await driver.stop();
  }
  assert.ok(
    spawned.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
});

test("a crashed driver is started again, and the idle timer stops it", async () => {
  const { host, spawned } = fakeHost({ idleMs: 50 });
  await assert.rejects(
    host.request(
      "tools/call",
      { name: "click", arguments: { crash: true } },
      "background",
    ),
    /stopped/,
  );
  const result = await host.request(
    "tools/call",
    { name: "click", arguments: {} },
    "background",
  );
  assert.match(result.content[0].text, /^click/);
  assert.equal(spawned.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(host.running, false);
});

test("the manifest must match this platform and stay inside its folder", () => {
  const dir = tmp();
  const write = (manifest: object) =>
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "bin"), "");
  const base = {
    executable: "bin",
    executableSha256: "x",
    platform: process.platform,
  };
  write(base);
  assert.ok(readDriverManifest(dir));
  write({ ...base, platform: "plan9" });
  assert.equal(readDriverManifest(dir), undefined);
  write({ ...base, executable: "../bin" });
  assert.equal(readDriverManifest(dir), undefined);
  write({ ...base, executable: "missing" });
  assert.equal(readDriverManifest(dir), undefined);
  assert.equal(readDriverManifest(path.join(dir, "nope")), undefined);
  assert.deepEqual(
    driverEnv(
      { env: { base: { A: "1", B: "0" }, fullControl: { B: "1" } } },
      "fullControl",
      { PATH: "/bin", OPENAI_API_KEY: "k" },
    ),
    { PATH: "/bin", A: "1", B: "1" },
  );
});
