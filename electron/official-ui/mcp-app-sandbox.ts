import fs from "node:fs";
import path from "node:path";

const originalParentOrigins =
  '["https://claude.ai","https://preview.claude.ai","app://localhost"]';

function declaredSources(value: string | null, frames = false): string {
  const sources: string[] = [];
  for (const entry of value?.split(" ") ?? []) {
    const authority = /^(https?|wss?):\/\/((?:\*\.)?[\w.-]+)(?::(\d+|\*))?(\/[^\s]*|[?#][^\s]*)?$/i.exec(entry);
    if (!authority) continue;
    const [, scheme, host, port, suffix] = authority;
    const wildcard = host.startsWith("*.");
    if ((wildcard && suffix) || (!wildcard && port === "*")) continue;
    const url = URL.parse(`${scheme}://${host}${port && port !== "*" ? `:${port}` : ""}`);
    if (!url) continue;
    if (frames && (url.protocol !== "https:" || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname))) continue;
    sources.push(url.origin + (port === "*" ? ":*" : ""));
  }
  return sources.length ? " " + sources.join(" ") : "";
}

export function createMcpAppSandbox(root: string, parentOrigin: string) {
  const file = path.join(root, "mcp_apps.html");
  if (!fs.existsSync(file)) return undefined;
  const document = fs.readFileSync(file, "utf8");
  if (!document.includes(originalParentOrigins)) throw Error("Missing official MCP App parent configuration.");
  const html = document.replace(originalParentOrigins, JSON.stringify([parentOrigin]));
  return (request: Request, url: URL) => {
    const resources = declaredSources(url.searchParams.get("resource-src"));
    const connect = declaredSources(url.searchParams.get("connect-src"));
    const frames = declaredSources(url.searchParams.get("frame-src"), true);
    const policy = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:" + resources,
      "style-src 'self' 'unsafe-inline'" + resources,
      "img-src 'self' data: blob:" + resources,
      "connect-src 'self' " + url.origin + " blob: data:" + connect,
      "font-src 'self' data:" + resources,
      "media-src 'self' blob: data:" + resources,
      "worker-src 'self' blob:" + resources,
      "frame-src blob: data:" + frames,
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors " + parentOrigin,
      "form-action 'self'",
      "webrtc 'block'",
      "upgrade-insecure-requests",
      "block-all-mixed-content",
    ].join("; ");
    return new Response(request.method === "HEAD" ? null : html, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy,
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
    } });
  };
}
