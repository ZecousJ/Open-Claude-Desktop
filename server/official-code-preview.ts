import type { IncomingMessage, ServerResponse } from "node:http";
import { isLocalDevHost } from "../shared/browser";
import {
  codePreviewHostLabel,
  codePreviewFrameUrl,
  codePreviewRelayPath,
  codePreviewRequestBytes,
  codePreviewRequestHeaders,
} from "../shared/official-code-preview";

const returnedHeaders = [
  "content-type",
  "content-encoding",
  "content-range",
  "accept-ranges",
  "content-disposition",
];

export function codePreviewHost(
  request: IncomingMessage,
  contentOrigin: string,
) {
  const host = request.headers.host?.toLowerCase();
  if (!host) return;
  const label = host.split(".")[0].replace(/^p-/, "");
  if (!codePreviewHostLabel.test(label)) return;
  const target = codePreviewFrameUrl(contentOrigin, label, "/");
  if (target && new URL(target).host === host) return label;
}

export async function serveCodePreview(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  parentOrigin: string,
) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    `frame-ancestors ${parentOrigin}; sandbox allow-scripts allow-same-origin allow-forms allow-modals`,
  );
  const sendError = (status: number, reason: string) => {
    response.statusCode = status;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><script>parent.postMessage(${JSON.stringify({
        type: "baku-preview-error",
        status,
        reason,
      })},${JSON.stringify(parentOrigin)})</script><p>${reason}</p>`,
    );
  };
  const path = request.url;
  if (!path || !/^\/(?![\/\\])/.test(path) || path.length > 8192)
    return sendError(400, "Invalid preview request.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > codePreviewRequestBytes)
      return sendError(413, "The preview request is too large.");
    chunks.push(chunk);
  }
  const headers: Record<string, string> = {};
  for (const name of codePreviewRequestHeaders) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const abort = new AbortController();
  response.once("close", () => abort.abort());
  let relay: Response;
  try {
    relay = await fetch(new URL(codePreviewRelayPath, parentOrigin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Claude-Code-Preview": token,
      },
      body: JSON.stringify({
        method: request.method,
        path,
        headers,
        body: Buffer.concat(chunks).toString("base64"),
      }),
      redirect: "error",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(24_000)]),
    });
  } catch {
    return sendError(502, "The preview server could not be reached.");
  }
  if (!relay.ok)
    return sendError(
      relay.status,
      relay.status === 404
        ? "This preview is no longer available."
        : "The preview server could not be reached.",
    );
  const data: {
    status: number;
    headers: Record<string, unknown>;
    body: string;
  } = await relay.json();
  for (const name of returnedHeaders) {
    const value = data.headers[name];
    if (typeof value === "string") response.setHeader(name, value);
  }
  const cookies = data.headers["set-cookie"];
  if (Array.isArray(cookies))
    response.setHeader(
      "Set-Cookie",
      cookies
        .filter((cookie): cookie is string => typeof cookie === "string")
        .map((cookie) => cookie.replace(/;\s*domain=[^;]*/gi, "")),
    );
  const location = data.headers.location;
  if (typeof location === "string") {
    const local = URL.parse(location);
    if (
      local &&
      /^https?:$/.test(local.protocol) &&
      isLocalDevHost(local.hostname)
    )
      response.setHeader(
        "Location",
        local.pathname + local.search + local.hash,
      );
    else if (
      !local &&
      URL.parse(location, "http://relative.invalid")?.origin ===
        "http://relative.invalid"
    )
      response.setHeader("Location", location);
  }
  response.statusCode = data.status;
  if (request.method === "HEAD") return response.end();
  const body = Buffer.from(data.body, "base64");
  if (
    typeof data.headers["content-type"] !== "string" ||
    !/^text\/html(?:\s*;|$)/i.test(data.headers["content-type"]) ||
    data.headers["content-encoding"]
  )
    return response.end(body);
  const html = body.toString("utf8");
  const position = /<head\b[^>]*>|<!doctype[^>]*>/i.exec(html);
  const insert = position ? position.index + position[0].length : 0;
  response.end(
    html.slice(0, insert) +
      previewNavigationScript(parentOrigin) +
      html.slice(insert),
  );
}

function previewNavigationScript(parentOrigin: string) {
  return `<script>(() => {
    const origin = ${JSON.stringify(parentOrigin)};
    const send = (data) => parent.postMessage(data, origin);
    const report = () => send({type:"baku-agent-navigate", path:location.pathname+location.search+location.hash});
    for (const name of ["pushState","replaceState"]) {
      const update = history[name];
      history[name] = function(...args) { update.apply(this, args); report(); };
    }
    addEventListener("popstate", report);
    addEventListener("hashchange", report);
    addEventListener("message", (event) => {
      if (event.source !== parent || event.origin !== origin || !event.data) return;
      const {type,path,delta,id,code} = event.data;
      if (type === "baku-agent-goto" && typeof path === "string" && path.startsWith("/") &&
          URL.parse(path, location.href)?.origin === location.origin) location.assign(path);
      if (type === "baku-agent-history" && (delta === -1 || delta === 1)) history.go(delta);
      if (typeof id !== "string") return;
      if (type === "baku-agent-eval" && code === "1") send({type:"baku-agent-result",id,result:1});
      else if (type === "baku-agent-eval" && code === "window.stop()") {
        window.stop(); send({type:"baku-agent-result",id});
      } else send({type:"baku-agent-result",id,error:"This preview action is unavailable."});
    });
    send({type:"baku-agent-ready"});
    addEventListener("load", report, {once:true});
  })()</script>`;
}
