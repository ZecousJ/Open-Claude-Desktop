/**
 * The stdio MCP server Codex starts for computer use (R10 design §3.1).
 * Built on its own by scripts/build.mjs into `dist-server/computer-use-mcp.cjs`
 * and run with ELECTRON_RUN_AS_NODE.
 *
 * It never touches the computer itself: it lists the fixed computer-use
 * tools and forwards each call to the app's broker over the local control
 * channel (`CLAUDEX_CU_SOCKET`, `CLAUDEX_CU_TOKEN`,
 * `CLAUDEX_CU_CONVERSATION`), which checks policy, settings, the person's
 * grants and tiers before the driver acts. Without the channel every tool
 * answers that computer use is not available.
 */
import net from "node:net";
import readline from "node:readline";
import {
  computerUseInstructions,
  computerUseTools,
  controlEnv,
  maxControlLine,
  unavailableText,
  type ComputerUseToolResult,
  type ControlCall,
  type ControlReply,
} from "../shared/computer-use";

const supportedProtocols = ["2025-06-18", "2025-03-26", "2024-11-05"];

const socketPath = process.env[controlEnv.socket] ?? "";
const token = process.env[controlEnv.token] ?? "";
const conversationId = process.env[controlEnv.conversation] ?? "";
// The adapter keeps nothing secret beyond this process.
delete process.env[controlEnv.token];

const unavailable = (): ComputerUseToolResult => ({
  content: [{ type: "text", text: unavailableText }],
  isError: true,
});

function write(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** The connection to the broker, opened on the first call and again after it drops. */
class Channel {
  private socket?: net.Socket;
  private connecting?: Promise<net.Socket>;
  private waiters = new Map<number, (result: ComputerUseToolResult) => void>();
  private nextId = 1;

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed)
      return Promise.resolve(this.socket);
    this.connecting ??= new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      let ready = false;
      const fail = () => {
        this.socket = undefined;
        for (const waiter of this.waiters.values()) waiter(unavailable());
        this.waiters.clear();
        if (!ready) reject(new Error("closed"));
      };
      socket.on("error", () => socket.destroy());
      socket.on("close", fail);
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ type: "hello", token, conversationId })}\n`,
        ),
      );
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const text = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let reply: ControlReply;
          try {
            reply = JSON.parse(text);
          } catch {
            socket.destroy();
            return;
          }
          if (reply.type === "ready") {
            ready = true;
            this.socket = socket;
            resolve(socket);
          } else if (reply.type === "result") {
            const waiter = this.waiters.get(reply.id);
            this.waiters.delete(reply.id);
            waiter?.(reply.result);
          }
        }
        // Results carry screenshots; allow them, but not without bound.
        if (buffer.length > 64 * maxControlLine) socket.destroy();
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    meta: { threadId?: string; turnId?: string },
  ): Promise<ComputerUseToolResult> {
    if (!socketPath || !token || !conversationId) return unavailable();
    let socket: net.Socket;
    try {
      socket = await this.connect();
    } catch {
      return unavailable();
    }
    const id = this.nextId++;
    const call: ControlCall = { type: "call", id, tool, args, ...meta };
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      socket.write(`${JSON.stringify(call)}\n`);
    });
  }
}

const channel = new Channel();
const toolNames = new Set(computerUseTools.map((tool) => tool.name));

function metaOf(params: any): { threadId?: string; turnId?: string } {
  const meta = params?._meta;
  if (!meta || typeof meta !== "object") return {};
  const turn = meta["x-codex-turn-metadata"];
  const threadId =
    typeof meta.threadId === "string"
      ? meta.threadId
      : typeof turn?.thread_id === "string"
        ? turn.thread_id
        : undefined;
  const turnId = typeof turn?.turn_id === "string" ? turn.turn_id : undefined;
  return {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

async function handle(message: any) {
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  const reply = (result: unknown) =>
    isRequest && write({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) =>
    isRequest && write({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      reply({
        protocolVersion: supportedProtocols.includes(asked)
          ? asked
          : supportedProtocols[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "claudex-computer-use", version: "1.0.0" },
        instructions: computerUseInstructions,
      });
      return;
    }
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: computerUseTools });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== "string" || !toolNames.has(name)) {
        fail(-32602, `Unknown tool: ${String(name)}`);
        return;
      }
      if (typeof args !== "object" || Array.isArray(args)) {
        fail(-32602, "Tool arguments must be an object.");
        return;
      }
      reply(await channel.call(name, args, metaOf(params)));
      return;
    }
    default:
      if (typeof method === "string" && method.startsWith("notifications/"))
        return;
      fail(-32601, `Method not found: ${String(method)}`);
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    write({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  void handle(message);
});
lines.on("close", () => process.exit(0));
