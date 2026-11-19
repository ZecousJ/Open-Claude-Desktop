import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { mcpAppSandboxPath } from "../../shared/official-usercontent-origin";
import { createMcpAppSandbox } from "./mcp-app-sandbox";

export const userContentOrigin = "https://www.claudeusercontent.com";

function parseUserContentParent(parentOrigin: string) {
  const parent = new URL(parentOrigin);
  if (
    parent.origin !== parentOrigin || parent.username || parent.password ||
    (parent.protocol !== "https:" && (parent.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parent.hostname)))
  )
    throw Error("Expected a secure or loopback official UI origin.");
  return parent;
}

/** Only the server-provided runtime configuration changes; published JS/CSS stay intact. */
export function configureUserContentDocument(html: string, parentOrigin: string) {
  const parent = parseUserContentParent(parentOrigin);
  let configured = false;
  const result = html.replace(
    /<script>([\s\S]*?)<[/]script>/g,
    (whole, script: string) => {
      const prefix = "self.__next_f.push(";
      if (!script.startsWith(prefix) || !script.endsWith(")")) return whole;
      const payload = JSON.parse(script.slice(prefix.length, -1));
      if (
        !Array.isArray(payload) ||
        payload[0] !== 1 ||
        typeof payload[1] !== "string"
      )
        return whole;
      let stream = payload[1] as string;
      if (!stream.includes('"allowedParentOrigins":')) return whole;
      stream = stream.replace(/"allowedParentOrigins":\[[^\]]*\]/g, () => {
        configured = true;
        return '"allowedParentOrigins":' + JSON.stringify([parent.origin]);
      });
      stream = stream.replace(
        /"defaultParentOrigin":"[^"]*"/g,
        () => '"defaultParentOrigin":' + JSON.stringify(parent.host),
      );
      payload[1] = stream;
      return (
        "<script>" +
        prefix +
        JSON.stringify(payload).replaceAll("<", "\\u003c") +
        " )</script>"
      );
    },
  );
  if (!configured)
    throw Error("Official user-content runtime configuration was not found.");
  return result;
}

/** A separate HTTPS origin served entirely from pinned local files, with no network fallback. */
export function createUserContentHandler(root: string, parentOrigin: string, previewOrigin = userContentOrigin) {
  const preview = new URL(previewOrigin), parent = parseUserContentParent(parentOrigin);
  if (preview.origin !== previewOrigin || preview.username || preview.password || preview.hostname === parent.hostname ||
      (preview.protocol !== "https:" && !(preview.protocol === "http:" && parent.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(preview.hostname) && ["localhost", "127.0.0.1", "[::1]"].includes(parent.hostname))))
    throw Error("Preview requires a separate secure or loopback hostname.");
  const sandbox = createMcpAppSandbox(root, parentOrigin);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const assets = new Map<string, { file: string; sha256: string }>(
    manifest.assets.map((a: any) => [a.path, a]),
  );
  const verified = new Set<string>();
  const mime: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
  };
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (
      url.origin !== previewOrigin ||
      !["GET", "HEAD"].includes(request.method)
    )
      return new Response("Forbidden", { status: 403 });
    if (url.pathname === mcpAppSandboxPath && sandbox) return sandbox(request, url);
    const entry = assets.get(url.pathname);
    if (!entry)
      return new Response("Uncaptured official preview resource", {
        status: 404,
      });
    const file = path.resolve(root, entry.file);
    if (!file.startsWith(path.resolve(root) + path.sep))
      return new Response("Forbidden", { status: 403 });
    const data = fs.readFileSync(file);
    if (!verified.has(file)) {
      if (createHash("sha256").update(data).digest("hex") !== entry.sha256)
        throw Error("Official preview resource checksum mismatch.");
      verified.add(file);
    }
    const document = url.pathname === "/";
    const body = document
      ? configureUserContentDocument(data.toString("utf8"), parentOrigin)
      : data;
    const policy = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'self' " + parentOrigin,
    ].join("; ");
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
        "Content-Security-Policy": policy,
        "Cache-Control": document
          ? "no-store"
          : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  };
}
