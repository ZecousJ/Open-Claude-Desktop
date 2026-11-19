import http from "node:http";
import { claudexHeaders } from "../../shared/claudex-contract";
import { claudexClientInfo } from "../sub2api/http";
import { endpoint } from "./gateway-chat";
import type { Gateway } from "./gateway";
import {
  knowledgeTimeoutMs,
  maxKnowledgeBytes,
  knowledgeRequestHeaders,
  knowledgeResponseHeaders,
  redact,
  readBody,
} from "./gateway-support";

/**
 * A knowledge base's MCP request (streamable HTTP), relayed to the service
 * with the account's key; the answer, JSON or an event stream, is passed
 * on as it arrives. Only the Claudex service has knowledge bases.
 */
export async function handleKnowledge(
  this: Gateway,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
) {
  const method = req.method ?? "";
  if (!["POST", "GET", "DELETE"].includes(method)) {
    res.writeHead(405).end();
    return;
  }
  const controller = new AbortController();
  const deadline = new Error("The knowledge base timed out.");
  const timeout = setTimeout(
    () => controller.abort(deadline),
    knowledgeTimeoutMs,
  );
  res.on("close", () => controller.abort());
  let apiKey = "";
  try {
    const current = this.getProvider();
    const { provider } = current;
    apiKey = current.apiKey;
    if (provider.backend !== "sub2api") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: { message: "Knowledge bases need the Claudex service." },
        }),
      );
      return;
    }
    const body =
      method === "POST" ? await readBody(req, maxKnowledgeBytes) : undefined;
    if (method === "POST" && !body) {
      res.writeHead(413).end();
      return;
    }
    const headers: Record<string, string> = {
      ...claudexHeaders(claudexClientInfo()),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    for (const name of knowledgeRequestHeaders) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = await fetch(
      endpoint(provider.baseUrl, `claudex/knowledge/${id}/mcp`),
      { method, headers, body, signal: controller.signal },
    );
    const out: Record<string, string> = {};
    for (const name of knowledgeResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) out["retry-after"] = retryAfter;
    res.writeHead(upstream.status, out);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    if (res.destroyed) return;
    if (!res.headersSent) {
      const timedOut = controller.signal.reason === deadline;
      res
        .writeHead(timedOut ? 504 : 502, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({
            error: {
              message: timedOut
                ? deadline.message
                : redact(
                    error instanceof Error ? error.message : String(error),
                    apiKey,
                  ),
            },
          }),
        );
    } else res.end();
  } finally {
    clearTimeout(timeout);
  }
}
