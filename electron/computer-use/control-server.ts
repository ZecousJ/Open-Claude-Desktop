/**
 * The local control channel between the computer-use MCP adapter (a child
 * Codex starts for a thread) and the broker (R10 design §3, §6.1).
 *
 * A Unix socket in a 0700 folder (macOS) or a named pipe with a random name
 * (Windows). Each connection starts with a hello naming its conversation
 * and a token: HMAC-SHA256 of the conversation id with a secret that is new
 * every time the app starts and never leaves the main process. So an
 * adapter can only act for the conversation Claudex started it for, and a
 * wrong token ends the connection.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  maxControlLine,
  type ComputerUseToolResult,
  type ControlCall,
  type ControlHello,
  type ControlReply,
} from "../../shared/computer-use";

export type CallHandler = (
  conversationId: string,
  call: ControlCall,
) => Promise<ComputerUseToolResult>;

export interface ControlServerOptions {
  /** Folder for the socket (macOS/Linux); a 0700 folder is created in it. */
  runDir: string;
  handle: CallHandler;
  platform?: NodeJS.Platform;
  /** How long a connection may take to say hello. */
  helloTimeoutMs?: number;
}

const maxSocketPath = 100;

export class ControlServer {
  private server?: net.Server;
  private secret = crypto.randomBytes(32);
  private sockets = new Set<net.Socket>();
  private socketDir?: string;
  /** A folder of our own in the temp directory (a long runDir path), removed on close. */
  private tempDir = false;
  address = "";

  constructor(private options: ControlServerOptions) {}

  /** The token the adapter of `conversationId` presents. */
  tokenFor(conversationId: string) {
    return crypto
      .createHmac("sha256", this.secret)
      .update(conversationId, "utf8")
      .digest("hex");
  }

  private tokenValid(conversationId: string, token: string) {
    const expected = Buffer.from(this.tokenFor(conversationId), "utf8");
    const given = Buffer.from(token, "utf8");
    return (
      expected.length === given.length &&
      crypto.timingSafeEqual(expected, given)
    );
  }

  private socketPath() {
    const platform = this.options.platform ?? process.platform;
    const name = crypto.randomBytes(8).toString("hex");
    if (platform === "win32") return `\\\\.\\pipe\\claudex-cu-${name}`;
    let dir = path.join(this.options.runDir, "run");
    if (path.join(dir, `cu-${name}.sock`).length > maxSocketPath) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cu-"));
      this.tempDir = true;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.socketDir = dir;
    return path.join(dir, `cu-${name}.sock`);
  }

  async start() {
    if (this.server) return;
    const address = this.socketPath();
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if ((this.options.platform ?? process.platform) !== "win32")
      fs.chmodSync(address, 0o600);
    this.server = server;
    this.address = address;
  }

  private accept(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let conversationId: string | undefined;
    let buffer = "";
    const helloTimer = setTimeout(
      () => socket.destroy(),
      this.options.helloTimeoutMs ?? 5000,
    );
    const send = (reply: ControlReply) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    };
    const line = (text: string) => {
      let message: any;
      try {
        message = JSON.parse(text);
      } catch {
        socket.destroy();
        return;
      }
      if (!conversationId) {
        const hello = message as ControlHello;
        if (
          hello?.type !== "hello" ||
          typeof hello.conversationId !== "string" ||
          typeof hello.token !== "string" ||
          !hello.conversationId ||
          !this.tokenValid(hello.conversationId, hello.token)
        ) {
          socket.destroy();
          return;
        }
        clearTimeout(helloTimer);
        conversationId = hello.conversationId;
        send({ type: "ready" });
        return;
      }
      const call = message as ControlCall;
      if (
        call?.type !== "call" ||
        typeof call.id !== "number" ||
        typeof call.tool !== "string" ||
        typeof call.args !== "object" ||
        call.args === null ||
        Array.isArray(call.args)
      ) {
        socket.destroy();
        return;
      }
      const from = conversationId;
      this.options
        .handle(from, {
          type: "call",
          id: call.id,
          tool: call.tool,
          args: call.args,
          ...(typeof call.threadId === "string"
            ? { threadId: call.threadId }
            : {}),
          ...(typeof call.turnId === "string" ? { turnId: call.turnId } : {}),
        })
        .catch((error): ComputerUseToolResult => ({
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        }))
        .then((result) => send({ type: "result", id: call.id, result }));
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (text.trim()) line(text);
        if (socket.destroyed) return;
      }
      if (buffer.length > maxControlLine) socket.destroy();
    });
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (
      this.socketDir &&
      (this.options.platform ?? process.platform) !== "win32"
    ) {
      fs.rmSync(this.address, { force: true });
      if (this.tempDir)
        fs.rmSync(this.socketDir, { recursive: true, force: true });
    }
    this.address = "";
  }
}
