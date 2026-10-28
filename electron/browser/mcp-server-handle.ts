import { randomUUID } from "node:crypto";
import http from "node:http";
import { mcpProtocolVersions } from "./mcp-server-support";
import { jsonRpcErrors } from "./mcp-server-support";
import { idKey } from "./mcp-server-support";
import { validId } from "./mcp-server-support";
import { isObject } from "./mcp-server-support";
import { elicitResultOf } from "./mcp-server-support";
import type { BrowserMcpServer } from "./mcp-server";
import type {
  McpCallResult,
  ElicitRequest,
  ElicitResult,
  McpCallContext,
  Session,
  JsonRpcId,
} from "./mcp-server";

export async function handle(
  this: BrowserMcpServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  // A web page (Origin) or another name for this address (rebinding) is refused first.
  if (req.headers.origin !== undefined || !this.hostAllowed(req))
    return void res.writeHead(403).end();
  if (!this.authorized(req))
    return void res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
  const match = /^\/mcp\/([A-Za-z0-9_-]{16,64})$/.exec(
    (req.url ?? "").split("?")[0],
  );
  const conversationId = match && this.capabilities.get(match[1]);
  if (!conversationId) return void res.writeHead(404).end();
  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId =
    typeof sessionHeader === "string" ? sessionHeader : undefined;

  if (req.method === "DELETE") {
    const session = sessionId && this.sessions.get(sessionId);
    if (!session || session.conversationId !== conversationId)
      return void res.writeHead(404).end();
    this.endSession(session);
    return void res.writeHead(204).end();
  }
  // No server-initiated stream outside calls (Codex opens one and accepts 405).
  if (req.method !== "POST")
    return void res.writeHead(405, { Allow: "POST, DELETE" }).end();
  if (
    !String(req.headers["content-type"] ?? "")
      .toLowerCase()
      .includes("application/json")
  )
    return void res.writeHead(415).end();
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > this.opts.maxBodyBytes) {
    res.writeHead(413, { Connection: "close" }).end();
    req.destroy();
    return;
  }
  const body = await this.readBody(req);
  if (body === undefined) {
    res.writeHead(413, { Connection: "close" }).end();
    req.destroy();
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(body.toString("utf8"));
  } catch {
    return this.jsonError(res, null, jsonRpcErrors.parse, "Parse error", 400);
  }
  if (Array.isArray(message))
    return this.jsonError(
      res,
      null,
      jsonRpcErrors.invalidRequest,
      "Batches aren't supported.",
      400,
    );
  if (!isObject(message) || message.jsonrpc !== "2.0")
    return this.jsonError(
      res,
      null,
      jsonRpcErrors.invalidRequest,
      "Invalid request",
      400,
    );
  const method = message.method;
  const id = message.id;

  // The client's answer to one of our requests (an elicitation).
  if (method === undefined) {
    const session = sessionId && this.sessions.get(sessionId);
    if (!session || session.conversationId !== conversationId)
      return void res.writeHead(404).end();
    if (validId(id)) {
      const pending = this.pending.get(String(id));
      if (pending && pending.sessionId === session.id) {
        this.pending.delete(String(id));
        pending.resolve(
          elicitResultOf("result" in message ? message.result : undefined),
        );
      }
    }
    return void res.writeHead(202).end();
  }
  if (typeof method !== "string")
    return this.jsonError(
      res,
      validId(id) ? id : null,
      jsonRpcErrors.invalidRequest,
      "Invalid request",
      400,
    );

  if (method === "initialize") {
    if (!validId(id))
      return this.jsonError(
        res,
        null,
        jsonRpcErrors.invalidRequest,
        "Invalid request",
        400,
      );
    return this.initialize(res, id, conversationId, message.params);
  }

  const session = sessionId ? this.sessions.get(sessionId) : undefined;
  if (!sessionId)
    return this.jsonError(
      res,
      validId(id) ? id : null,
      jsonRpcErrors.invalidRequest,
      "Mcp-Session-Id is required.",
      400,
    );
  if (!session || session.conversationId !== conversationId)
    return void res.writeHead(404).end();
  session.lastUsed = Date.now();

  // Notifications.
  if (id === undefined) {
    if (method === "notifications/cancelled" && isObject(message.params)) {
      const requestId = message.params.requestId;
      if (validId(requestId)) session.calls.get(idKey(requestId))?.abort();
    }
    return void res.writeHead(202).end();
  }
  if (!validId(id))
    return this.jsonError(
      res,
      null,
      jsonRpcErrors.invalidRequest,
      "Invalid request",
      400,
    );
  switch (method) {
    case "ping":
      return this.jsonResult(res, id, {});
    case "tools/list":
      return this.jsonResult(res, id, {
        tools: this.options.handlers.tools(conversationId),
      });
    case "tools/call":
      return this.callTool(req, res, id, session, message.params);
    default:
      return this.jsonError(
        res,
        id,
        jsonRpcErrors.methodNotFound,
        `Method not found: ${method}`,
      );
  }
}

export function readBody(
  this: BrowserMcpServer,
  req: http.IncomingMessage,
): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > this.opts.maxBodyBytes) {
        over = true;
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!over) reject(error);
    });
    // A client that went away mid-body: nothing to answer.
    req.on("close", () => {
      if (!over && !req.complete) resolve(undefined);
    });
  });
}

export function initialize(
  this: BrowserMcpServer,
  res: http.ServerResponse,
  id: JsonRpcId,
  conversationId: string,
  params: unknown,
) {
  const p = isObject(params) ? params : {};
  const requested =
    typeof p.protocolVersion === "string" ? p.protocolVersion : "";
  const protocolVersion = (mcpProtocolVersions as readonly string[]).includes(
    requested,
  )
    ? requested
    : mcpProtocolVersions[0];
  const capabilities = isObject(p.capabilities) ? p.capabilities : {};
  const session: Session = {
    id: randomUUID(),
    conversationId,
    elicitation: isObject(capabilities.elicitation),
    protocolVersion,
    calls: new Map(),
    lastUsed: Date.now(),
  };
  // Old sessions of the conversation make room (a client that restarted).
  const own = [...this.sessions.values()]
    .filter((value) => value.conversationId === conversationId)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (own.length >= this.opts.maxSessionsPerConversation)
    this.endSession(own.shift()!);
  this.sessions.set(session.id, session);
  const instructions = this.options.handlers.instructions?.(conversationId);
  this.jsonResult(
    res,
    id,
    {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.opts.serverName,
        version: this.opts.serverVersion,
      },
      ...(instructions ? { instructions } : {}),
    },
    { "Mcp-Session-Id": session.id },
  );
}

export async function callTool(
  this: BrowserMcpServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: JsonRpcId,
  session: Session,
  params: unknown,
) {
  const p = isObject(params) ? params : {};
  const name = p.name;
  if (typeof name !== "string" || !name)
    return this.jsonError(
      res,
      id,
      jsonRpcErrors.invalidParams,
      "A tool name is required.",
    );
  const args = p.arguments === undefined ? {} : p.arguments;
  if (!isObject(args))
    return this.jsonError(
      res,
      id,
      jsonRpcErrors.invalidParams,
      "Tool arguments must be an object.",
    );
  const conversationId = session.conversationId;
  const mine = this.running.get(conversationId) ?? 0;
  if (
    mine >= this.opts.maxCallsPerConversation ||
    this.runningTotal >= this.opts.maxCalls
  )
    return this.jsonError(
      res,
      id,
      jsonRpcErrors.busy,
      "Too many browser actions are running at once. Wait for them to finish.",
    );
  const key = idKey(id);
  if (session.calls.has(key))
    return this.jsonError(
      res,
      id,
      jsonRpcErrors.invalidRequest,
      "A call with this id is already running.",
    );

  this.running.set(conversationId, mine + 1);
  this.runningTotal++;
  const controller = new AbortController();
  session.calls.set(key, controller);
  const stream = String(req.headers.accept ?? "")
    .toLowerCase()
    .includes("text/event-stream");
  let keepAlive: NodeJS.Timeout | undefined;
  const gone = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", gone);
  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, this.opts.keepAliveMs);
    keepAlive.unref?.();
  }
  const send = (payload: unknown) =>
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  const context: McpCallContext = {
    conversationId,
    canElicit: stream && session.elicitation,
    signal: controller.signal,
    meta: p._meta,
    elicit: (request) =>
      this.elicit(session, controller.signal, request, stream, send),
  };
  let result: McpCallResult;
  try {
    result = await this.options.handlers.call(name, args, context);
  } catch (error) {
    result = {
      content: [
        {
          type: "text",
          text:
            error instanceof Error && error.message
              ? error.message
              : "The browser action failed.",
        },
      ],
      isError: true,
    };
  } finally {
    clearInterval(keepAlive);
    session.calls.delete(key);
    res.off("close", gone);
    const left = (this.running.get(conversationId) ?? 1) - 1;
    if (left > 0) this.running.set(conversationId, left);
    else this.running.delete(conversationId);
    this.runningTotal = Math.max(0, this.runningTotal - 1);
  }
  if (res.writableEnded || res.destroyed) return;
  const reply = { jsonrpc: "2.0", id, result };
  if (stream) {
    send(reply);
    res.end();
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  }
}

export function elicit(
  this: BrowserMcpServer,
  session: Session,
  signal: AbortSignal,
  request: ElicitRequest,
  stream: boolean,
  send: (payload: unknown) => void,
): Promise<ElicitResult> {
  if (!stream || !session.elicitation || signal.aborted || this.closed)
    return Promise.resolve({ action: "cancel" });
  const elicitationId = `claudex-elicit-${this.nextElicitation++}`;
  return new Promise<ElicitResult>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ElicitResult) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(elicitationId);
      resolve(result);
    };
    const onAbort = () => finish({ action: "cancel" });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish({ action: "cancel" }),
      this.opts.elicitationTimeoutMs,
    );
    timer.unref?.();
    this.pending.set(elicitationId, {
      sessionId: session.id,
      resolve: finish,
    });
    send({
      jsonrpc: "2.0",
      id: elicitationId,
      method: "elicitation/create",
      params: request,
    });
  });
}
