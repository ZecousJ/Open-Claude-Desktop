/**
 * The Browser tools' MCP server (R8 design 3.1 and 6.4): the subset of the
 * MCP streamable HTTP transport Codex 0.144.1 uses (tests/spikes, SP-1),
 * written on node:http so no npm package is added.
 *
 * - One server per signed-in account on 127.0.0.1 and a random port.
 * - Every request carries `Authorization: Bearer <token>`. The token is
 *   random per account session and reaches Codex only through the
 *   app-server environment (`bearer_token_env_var`), which the commands the
 *   agent runs never see.
 * - The path is `/mcp/<capability>`: a random string per conversation, so a
 *   thread only ever reaches its own conversation's browser (Codex takes the
 *   URL per thread from `thread/start` config).
 * - Requests with an `Origin` header (a web page) or a Host other than this
 *   server's address (DNS rebinding) are refused; bodies are capped and so
 *   are the actions running at once.
 * - `initialize`, `ping`, `tools/list`, `tools/call`; notifications and
 *   `notifications/cancelled`. A tool that needs the person's approval sends
 *   `elicitation/create` on the call's SSE stream; the answer comes back on
 *   a new POST (Codex shows it as `mcpServer/elicitation/request`).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as mcpServerHandle from "./mcp-server-handle";
import { installMethods } from "./install-methods";

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

/** An MCP `elicitation/create` request (form mode). */
export interface ElicitRequest {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** What a tool call knows about where it came from. */
export interface McpCallContext {
  conversationId: string;
  /** The client can show a question to the person (declared elicitation, SSE response). */
  canElicit: boolean;
  /** Asks the person; `cancel` when the call ended, timed out or can't ask. */
  elicit(request: ElicitRequest): Promise<ElicitResult>;
  /** Aborted when the client cancelled the call or went away. */
  signal: AbortSignal;
  /** The call's `_meta` (Codex sends the thread and turn). */
  meta: unknown;
}

export interface McpHandlers {
  tools(conversationId: string): McpTool[];
  call(
    name: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpCallResult>;
  /** The server's `instructions` in the initialize result. */
  instructions?(conversationId: string): string | undefined;
}

export interface BrowserMcpServerOptions {
  /** The bearer token clients must send. */
  token: string;
  handlers: McpHandlers;
  serverName?: string;
  serverVersion?: string;
  /** Largest request body (1 MB). */
  maxBodyBytes?: number;
  /** Tool calls one conversation may have running at once (4). */
  maxCallsPerConversation?: number;
  /** Tool calls running at once in all (32). */
  maxCalls?: number;
  /** How long a question waits for the person (10 minutes). */
  elicitationTimeoutMs?: number;
  /** SSE comment interval while a call runs (15 s). */
  keepAliveMs?: number;
  /** Sessions kept per conversation; the oldest goes first (8). */
  maxSessionsPerConversation?: number;
}

export interface Session {
  id: string;
  conversationId: string;
  elicitation: boolean;
  protocolVersion: string;
  /** In-flight calls by JSON-RPC id, for notifications/cancelled. */
  calls: Map<string, AbortController>;
  lastUsed: number;
}

interface PendingElicitation {
  sessionId: string;
  resolve(result: ElicitResult): void;
}

export type JsonRpcId = string | number;

export class BrowserMcpServer {
  private server = http.createServer((req, res) => {
    this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  capabilities = new Map<string, string>(); // capability → conversation
  private byConversation = new Map<string, string>(); // conversation → capability
  sessions = new Map<string, Session>();
  pending = new Map<string, PendingElicitation>();
  running = new Map<string, number>(); // conversation → calls
  runningTotal = 0;
  nextElicitation = 1;
  private listening = false;
  closed = false;
  private tokenBytes: Buffer;
  opts: Required<Omit<BrowserMcpServerOptions, "token" | "handlers">>;

  constructor(public options: BrowserMcpServerOptions) {
    if (options.token.length < 16)
      throw new Error("The Browser tools token is too short.");
    this.tokenBytes = Buffer.from(`Bearer ${options.token}`);
    this.opts = {
      serverName: options.serverName ?? "claudex_browser",
      serverVersion: options.serverVersion ?? "1.0.0",
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
      maxCallsPerConversation: options.maxCallsPerConversation ?? 4,
      maxCalls: options.maxCalls ?? 32,
      elicitationTimeoutMs: options.elicitationTimeoutMs ?? 10 * 60_000,
      keepAliveMs: options.keepAliveMs ?? 15_000,
      maxSessionsPerConversation: options.maxSessionsPerConversation ?? 8,
    };
    this.server.headersTimeout = 20_000;
    this.server.requestTimeout = 0; // Calls may wait for the person.
    this.server.keepAliveTimeout = 5_000;
  }

  /** Listens on 127.0.0.1 and a free port. */
  async start() {
    if (this.closed) throw new Error("The Browser tools server is closed.");
    if (this.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.listening = true;
    // The app (or the runner) keeps the process alive; a tools server left
    // listening by a context that never closed must not.
    this.server.unref();
  }

  /** The port, once listening. */
  get port(): number | undefined {
    if (!this.listening) return undefined;
    return (this.server.address() as AddressInfo | null)?.port;
  }

  /** The conversation's MCP address (its capability is made on first use and kept). */
  url(conversationId: string): string | undefined {
    const port = this.port;
    if (!port || this.closed) return undefined;
    let capability = this.byConversation.get(conversationId);
    if (!capability) {
      capability = randomBytes(16).toString("base64url");
      this.byConversation.set(conversationId, capability);
      this.capabilities.set(capability, conversationId);
    }
    return `http://127.0.0.1:${port}/mcp/${capability}`;
  }

  /** The conversation is gone: its address and sessions stop working. */
  revoke(conversationId: string) {
    const capability = this.byConversation.get(conversationId);
    if (capability) this.capabilities.delete(capability);
    this.byConversation.delete(conversationId);
    for (const session of [...this.sessions.values()])
      if (session.conversationId === conversationId) this.endSession(session);
  }

  /** Conversations that have an address. */
  conversations() {
    return [...this.byConversation.keys()];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions.values()]) this.endSession(session);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve({ action: "cancel" });
    }
    this.capabilities.clear();
    this.byConversation.clear();
    if (!this.listening) return;
    this.listening = false;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  endSession(session: Session) {
    this.sessions.delete(session.id);
    for (const controller of session.calls.values()) controller.abort();
    session.calls.clear();
    for (const [id, pending] of this.pending)
      if (pending.sessionId === session.id) {
        this.pending.delete(id);
        pending.resolve({ action: "cancel" });
      }
  }

  // -------------------------------------------------------------------------
  // HTTP

  authorized(req: http.IncomingMessage) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const given = Buffer.from(header);
    return (
      given.length === this.tokenBytes.length &&
      timingSafeEqual(given, this.tokenBytes)
    );
  }

  hostAllowed(req: http.IncomingMessage) {
    const port = this.port;
    const host = String(req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  jsonResult(
    res: http.ServerResponse,
    id: JsonRpcId,
    result: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(200, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  jsonError(
    res: http.ServerResponse,
    id: JsonRpcId | null,
    code: number,
    message: string,
    status = 200,
  ) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
}

export interface BrowserMcpServer {
  handle: OmitThisParameter<typeof mcpServerHandle.handle>;
  readBody: OmitThisParameter<typeof mcpServerHandle.readBody>;
  initialize: OmitThisParameter<typeof mcpServerHandle.initialize>;
  callTool: OmitThisParameter<typeof mcpServerHandle.callTool>;
  elicit: OmitThisParameter<typeof mcpServerHandle.elicit>;
}
installMethods(BrowserMcpServer.prototype, mcpServerHandle);
