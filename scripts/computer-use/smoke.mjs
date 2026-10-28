// Starts the installed computer use driver the way Claudex does (direct child
// process, stdio MCP, the "base" environment from the manifest) and checks the
// MCP handshake and tool list. It performs no UI action.
//
// Usage: node scripts/computer-use/smoke.mjs [--dir build/computer-use]
//          [--list-apps] [--timeout <ms>]
//
// --list-apps additionally calls list_apps (read-only, needs no permission) and
// prints only how many lines came back, never app names.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const options = {
    dir: path.join(project, "build", "computer-use"),
    listApps: false,
    timeout: 20_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = path.resolve(argv[++i] ?? "");
    else if (arg === "--list-apps") options.listApps = true;
    else if (arg === "--timeout") options.timeout = Number(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

// Minimal line-delimited JSON-RPC client, the framing MCP stdio uses.
function connect(child) {
  const pending = new Map();
  let nextId = 1;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`driver exited (${signal ?? code})`));
    pending.clear();
  });
  return {
    request(method, params) {
      const id = nextId++;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
    },
    notify(method, params) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    },
  };
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function smoke(argv) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(options.dir, "manifest.json"), "utf8"),
  );
  const executable = path.join(options.dir, manifest.executable);
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(executable))
    .digest("hex");
  if (hash !== manifest.executableSha256)
    throw new Error("Installed driver does not match manifest.json");
  const env = { ...process.env, ...(manifest.env?.base ?? {}) };

  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    timeout: options.timeout,
    windowsHide: true,
  });
  const reported = (version.stdout ?? "").trim();
  if (version.status !== 0 || reported !== manifest.version)
    throw new Error(
      `--version reported ${JSON.stringify(reported)} (exit ${version.status}), expected ${manifest.version}`,
    );
  console.log(`version: ${reported}`);

  const child = spawn(executable, manifest.args ?? ["mcp"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const rpc = connect(child);
  try {
    const init = await withTimeout(
      rpc.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "claudex-computer-use-smoke", version: "1" },
      }),
      options.timeout,
      "initialize",
    );
    rpc.notify("notifications/initialized");
    console.log(
      `server: ${init?.serverInfo?.name} ${init?.serverInfo?.version} (protocol ${init?.protocolVersion})`,
    );
    const listed = await withTimeout(
      rpc.request("tools/list", {}),
      options.timeout,
      "tools/list",
    );
    const names = (listed?.tools ?? []).map((tool) => tool.name).sort();
    console.log(`tools: ${names.join(", ")}`);
    const missing = (manifest.tools ?? []).filter(
      (name) => !names.includes(name),
    );
    const extra = names.filter(
      (name) => !(manifest.tools ?? []).includes(name),
    );
    if (missing.length)
      throw new Error(`Driver is missing tools: ${missing.join(", ")}`);
    if (extra.length)
      console.log(
        `note: driver has tools not in the manifest: ${extra.join(", ")}`,
      );
    if (options.listApps) {
      const result = await withTimeout(
        rpc.request("tools/call", { name: "list_apps", arguments: {} }),
        options.timeout,
        "list_apps",
      );
      const text = (result?.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      console.log(
        `list_apps: isError=${Boolean(result?.isError)}, ${text.split("\n").filter(Boolean).length} lines`,
      );
    }
  } catch (error) {
    if (stderr.trim()) console.error(`driver stderr: ${stderr.trim()}`);
    throw error;
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const timer = setTimeout(() => child.kill(), 3000);
      await exited;
      clearTimeout(timer);
    }
  }
  console.log("smoke: ok");
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly)
  smoke(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
