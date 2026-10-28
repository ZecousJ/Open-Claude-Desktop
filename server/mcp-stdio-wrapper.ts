import { spawn } from "node:child_process";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  mcpStdioCaptureEnvironment,
  type McpStdioDescriptor,
} from "../shared/mcp-stdio-logs";
import {
  mcpSecrets,
  redactMcpText,
} from "../electron/connectors/mcp-connection-logs";
import {
  captureState,
  liveMcpLease,
  McpPrivateLogStore,
} from "./mcp-private-log-store";

async function run() {
  const raw = process.env[mcpStdioCaptureEnvironment];
  delete process.env[mcpStdioCaptureEnvironment];
  if (!raw || Buffer.byteLength(raw) > 2 * 1024 * 1024)
    throw Error("Invalid private MCP capture launch.");
  const address = JSON.parse(raw) as {
    socketPath: string;
    owner: string;
    version: string;
    token: string;
  };
  if (
    !address ||
    typeof address.socketPath !== "string" ||
    !address.socketPath.startsWith("/") ||
    ![address.owner, address.version, address.token].every(
      (value) => typeof value === "string",
    )
  )
    throw Error("Invalid private MCP bootstrap.");
  const spec = await new Promise<McpStdioDescriptor>((resolve, reject) => {
    const socket = net.createConnection(address.socketPath);
    socket.setEncoding("utf8");
    let received = "";
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("Private MCP bootstrap timed out.")),
    );
    socket.on("connect", () => socket.write(`${JSON.stringify(address)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (Buffer.byteLength(received) > 2 * 1024 * 1024)
        socket.destroy(new Error("Invalid private MCP bootstrap."));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(received));
      } catch {
        reject(Error("Private MCP bootstrap unavailable."));
      }
    });
  });
  if (
    !spec ||
    typeof spec.command !== "string" ||
    !Array.isArray(spec.args) ||
    !spec.args.every((value) => typeof value === "string") ||
    !spec.environment ||
    !Object.values(spec.environment).every(
      (value) => typeof value === "string",
    ) ||
    !Array.isArray(spec.secrets) ||
    !spec.secrets.every(
      (value) => typeof value === "string" && value.length <= 65536,
    ) ||
    !liveMcpLease(spec)
  )
    throw Error("Invalid private MCP capture launch.");
  const store = new McpPrivateLogStore(spec);
  const environment = { ...process.env, ...spec.environment };
  delete environment[mcpStdioCaptureEnvironment];
  if (spec.restoreRunAsNode) {
    if (spec.restoreRunAsNode.value === undefined)
      delete environment.ELECTRON_RUN_AS_NODE;
    else environment.ELECTRON_RUN_AS_NODE = spec.restoreRunAsNode.value;
  }
  const scrubInputs = [...spec.secrets, ...mcpSecrets({ env: environment })];
  const scrubAvailable = scrubInputs.every((value) => value.length <= 65536);
  let captureFailed = !scrubAvailable;
  const append = (line: string) => {
    if (!store.appendRedacted(line)) {
      captureFailed = true;
      captureState(spec, "failed");
    }
  };
  const secrets = [
    ...new Set(
      scrubInputs
        .flatMap((value) => [
          value,
          JSON.stringify(value).slice(1, -1),
          ...value.split(/\r?\n/),
        ])
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  const child = spawn(spec.command, spec.args, {
    env: environment,
    cwd: spec.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let suppress = false;
  const consume = (text: string, final = false) => {
    if (!scrubAvailable) return;
    pending += text;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (suppress || line.length > 65536) {
        append("[oversized stderr line suppressed]");
        store.dropped();
        suppress = false;
      } else append(redactMcpText(line, secrets));
    }
    if (pending.length > 65536) {
      pending = "";
      suppress = true;
    }
    if (final && (pending || suppress)) {
      if (suppress) {
        append("[oversized stderr line suppressed]");
        store.dropped();
      } else append(redactMcpText(pending, secrets));
      pending = "";
    }
  };
  // Pipes preserve exact bytes and native stream backpressure; stdout is never logged.
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stdin.on("error", () => process.stdin.unpipe(child.stdin));
  process.stdout.on("error", () => child.kill("SIGTERM"));
  child.stderr.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));
  child.stderr.on("end", () => consume(decoder.end(), true));
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const forward = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => {
      child.kill(signal);
    };
    forward.set(signal, handler);
    process.on(signal, handler);
  }
  let retired = false;
  let spawnFailed = false;
  let escalation: NodeJS.Timeout | undefined;
  const lease = setInterval(() => {
    if (!liveMcpLease(spec) && !retired) {
      retired = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 2000);
      escalation.unref();
    }
  }, 100);
  lease.unref();
  captureState(spec, captureFailed ? "failed" : "capturing");
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("error", () => {
      spawnFailed = true;
      captureState(spec, "failed");
      resolve({ code: 1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(lease);
  if (escalation) clearTimeout(escalation);
  for (const [signal, handler] of forward) process.off(signal, handler);
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  captureState(spec, spawnFailed || captureFailed ? "failed" : "stopped");
  if (result.signal && process.platform !== "win32")
    process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
void run().catch(() => {
  process.stderr.write("MCP stderr capture is unavailable.\n");
  process.exitCode = 1;
});
