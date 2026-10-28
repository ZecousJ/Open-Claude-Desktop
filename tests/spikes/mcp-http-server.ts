/**
 * Minimal MCP streamable HTTP server (the subset R8's claudex_browser plans to
 * implement without new npm dependencies): initialize, tools/list, tools/call,
 * ping, and a server → client elicitation/create sent on the POST's SSE stream
 * with the answer arriving on a new POST.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "./harness";

/** 1×1 transparent PNG. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export type McpLog = {
  method: string;
  authorization?: string;
  sessionId?: string;
  params?: Json;
  httpMethod: string;
};

export class McpHttpServer {
  log: McpLog[] = [];
  elicitationAnswers: Json[] = [];
  private server = http.createServer((req, res) => this.handle(req, res));
  private waiting = new Map<string, (result: Json) => void>();
  private sessions = 0;
  private elicitations = 0;
  url = "";
  constructor(
    readonly token: string,
    readonly toolPrefix = "probe",
  ) {}
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/mcp`;
    return this;
  }
  close() {
    this.server.closeAllConnections();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  private tools() {
    const p = this.toolPrefix;
    return [
      {
        name: `${p}_echo`,
        description: "Echo a marker back (spike fixture).",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: `${p}_ask`,
        description: "Ask the user through MCP elicitation (spike fixture).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: `${p}_image`,
        description: "Return a tiny PNG image (spike fixture).",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const authorization = req.headers.authorization;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (req.method !== "POST") {
      this.log.push({
        method: "(http)",
        httpMethod: req.method!,
        authorization,
      });
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    this.log.push({
      method: msg.method ?? `(response ${msg.id})`,
      authorization,
      sessionId,
      params: msg.params ?? msg.result ?? msg.error,
      httpMethod: "POST",
    });
    if (authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    // A client's answer to a server request.
    if (!msg.method && msg.id !== undefined) {
      this.waiting.get(String(msg.id))?.(msg.result ?? { error: msg.error });
      res.writeHead(202).end();
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const json = (result: Json, headers: Json = {}) => {
      res.writeHead(200, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    switch (msg.method) {
      case "initialize":
        return json(
          {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "spike-mcp", version: "0.0.1" },
          },
          { "Mcp-Session-Id": `spike-session-${++this.sessions}` },
        );
      case "ping":
        return json({});
      case "tools/list":
        return json({ tools: this.tools() });
      case "tools/call":
        return this.call(msg, res, json);
      default:
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "method not found" },
          }),
        );
    }
  }
  private async call(
    msg: Json,
    res: http.ServerResponse,
    json: (result: Json) => void,
  ) {
    const name: string = msg.params?.name ?? "";
    if (name.endsWith("_echo"))
      return json({
        content: [
          { type: "text", text: `ECHO:${msg.params?.arguments?.text ?? ""}` },
        ],
      });
    if (name.endsWith("_image"))
      return json({
        content: [
          { type: "text", text: "IMAGE_FOLLOWS" },
          { type: "image", data: TINY_PNG, mimeType: "image/png" },
        ],
      });
    // _ask: stream an elicitation request, wait for the answer on a new POST.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const elicitId = `elicit-${++this.elicitations}`;
    const answer = new Promise<Json>((resolve) =>
      this.waiting.set(elicitId, resolve),
    );
    res.write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: elicitId,
        method: "elicitation/create",
        params: {
          message: "Allow the spike tool to continue?",
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                title: "Choice",
                enum: ["allow_once", "deny"],
              },
            },
            required: ["choice"],
          },
        },
      })}\n\n`,
    );
    const timeout = new Promise<Json>((r) =>
      setTimeout(() => r({ timeout: true }), 20_000),
    );
    const result = await Promise.race([answer, timeout]);
    this.waiting.delete(elicitId);
    this.elicitationAnswers.push(result);
    res.write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: `ELICITED:${JSON.stringify(result)}` },
          ],
        },
      })}\n\n`,
    );
    res.end();
  }
}
