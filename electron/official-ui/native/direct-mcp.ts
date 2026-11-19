import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { MessagePortMain } from "electron";

const serverMap = z.record(z.string(), z.unknown());
const launchConfig = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
}).passthrough();
const messageMap = z.record(z.string(), z.unknown());

type LaunchConfig = z.infer<typeof launchConfig>;
type RpcMessage = Record<string, unknown>;
type Session = {
  uuid: string;
  serverName: string;
  child: ChildProcessWithoutNullStreams;
  port: MessagePortMain;
  pending: Map<string, string | number | null>;
  closed: boolean;
};

export interface DirectMcpBridgeOptions {
  /** The active engine's resolved, authorized MCP launch configuration. */
  mcpConfig(): string;
  /** False once the NativeHost or its account lease has retired. */
  isCurrent(): boolean;
}

function rpcMessage(value: unknown): RpcMessage {
  const parsed = messageMap.safeParse(value);
  if (!parsed.success || parsed.data.jsonrpc !== "2.0")
    throw Error("MCP server sent an invalid message.");
  const message = parsed.data;
  if (
    (message.method !== undefined && typeof message.method !== "string") ||
    (message.method === undefined &&
      (!Object.hasOwn(message, "id") ||
        (!Object.hasOwn(message, "result") &&
          !Object.hasOwn(message, "error")))) ||
    (Object.hasOwn(message, "id") &&
      message.id !== null &&
      typeof message.id !== "string" &&
      typeof message.id !== "number")
  )
    throw Error("MCP server sent an invalid message.");
  return message;
}

function messageId(message: RpcMessage): string | number | null | undefined {
  const id = message.id;
  if (id === null || typeof id === "string" || typeof id === "number")
    return id;
  return undefined;
}

function eventData(event: Electron.MessageEvent) {
  return event.data;
}

export function createDirectMcpBridge(options: DirectMcpBridgeOptions) {
  const sessions = new Map<string, Session>();
  let disposed = false;

  const current = () => {
    try {
      return !disposed && options.isCurrent();
    } catch {
      return false;
    }
  };
  const configuredServers = () => {
    if (!current()) throw Error("This account window has retired.");
    const value: unknown = JSON.parse(options.mcpConfig());
    return serverMap.parse(value);
  };
  const configuredLaunch = (name: string) => {
    const config = configuredServers()[name];
    const parsed = launchConfig.safeParse(config);
    if (!parsed.success || parsed.data.enabled === false)
      throw Error("MCP server is unavailable.");
    return parsed.data;
  };

  const stop = (session: Session, reason: string, sendErrors: boolean) => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.uuid);
    if (sendErrors) {
      for (const id of session.pending.values()) {
        try {
          session.port.postMessage({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: reason },
          });
        } catch {}
      }
    }
    session.pending.clear();
    try {
      session.port.close();
    } catch {}
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (session.child.exitCode === null && session.child.signalCode === null)
          session.child.kill("SIGKILL");
      }, 2000);
      force.unref();
      session.child.once("close", () => clearTimeout(force));
    }
  };

  const list = () =>
    Object.entries(configuredServers()).flatMap(([name, value]) => {
      const parsed = launchConfig.safeParse(value);
      return parsed.success && parsed.data.enabled !== false ? [name] : [];
    });

  const connect = (serverName: string, port: MessagePortMain) => {
    const spec: LaunchConfig = configuredLaunch(serverName);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const session: Session = {
      uuid: randomUUID(),
      serverName,
      child,
      port,
      pending: new Map(),
      closed: false,
    };
    sessions.set(session.uuid, session);

    const fail = (reason: string) => stop(session, reason, true);
    let stdout = "";
    const decoder = new StringDecoder("utf8");
    const readStdout = (text: string) => {
      stdout += text;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline).replace(/\r$/, "");
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const message = rpcMessage(JSON.parse(line));
          const id = messageId(message);
          if (message.method === undefined && id !== undefined)
            session.pending.delete(JSON.stringify(id));
          port.postMessage(message);
        } catch {
          fail("MCP server sent an invalid message.");
          return;
        }
      }
    };

    port.on("message", (event) => {
      if (session.closed) return;
      if (!current()) return stop(session, "The account changed.", true);
      try {
        const message = rpcMessage(eventData(event));
        const serialized = JSON.stringify(message);
        if (serialized === undefined) throw Error("Invalid MCP message.");
        if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
          const id = messageId(message);
          if (id !== undefined) session.pending.set(JSON.stringify(id), id);
        }
        child.stdin.write(`${serialized}\n`);
      } catch {
        fail("The MCP client sent an invalid message.");
      }
    });
    port.on("close", () => stop(session, "MCP connection closed.", false));
    port.start();

    child.stdout.on("data", (chunk: Buffer) => readStdout(decoder.write(chunk)));
    child.stdout.on("end", () => {
      const final = decoder.end();
      if (final) readStdout(final);
      if (stdout.trim()) fail("MCP server sent an incomplete message.");
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => fail("MCP server closed its input."));
    child.stdout.on("error", () => fail("MCP server output failed."));
    child.once("error", () => fail("MCP server failed to start."));
    child.once("close", () => {
      if (!session.closed) fail("MCP server exited.");
    });

    return session.uuid;
  };

  const retireServer = (serverName: string) => {
    for (const session of sessions.values())
      if (session.serverName === serverName)
        stop(session, "MCP server configuration changed.", true);
  };
  const retireAll = () => {
    for (const session of [...sessions.values()])
      stop(session, "MCP server configuration changed.", true);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    retireAll();
  };

  return { list, connect, retireServer, retireAll, dispose };
}
