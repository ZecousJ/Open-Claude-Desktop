import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { sandboxFileName } from "./sandbox/sandbox-setup.ts";
import { type DenyReason } from "./net-policy.ts";

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Splits `host:port` / `[v6]:port` of a CONNECT request. */
export function parseAuthority(
  authority: string,
): { host: string; port: number } | undefined {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority);
  if (!m) return undefined;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return undefined;
  return { host: (m[1] ?? m[2])!, port };
}

export function refusal(
  status: number,
  reason: DenyReason | "error",
  message: string,
) {
  const body = `${message}\n`;
  return (
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `X-Claudex-Egress: ${reason}\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n${body}`
  );
}

export function statusFor(reason: DenyReason) {
  if (reason === "unresolved") return 502;
  if (reason === "bad-host") return 400;
  return 403;
}

/** Largest ClientHello the proxy waits for (TLS allows 2^24, real ones are < 8 KB). */
export const MAX_HELLO_BYTES = 64 * 1024;

/**
 * Makes sure a stale socket file from an earlier run does not block the
 * listener, without ever removing anything that is not a socket.
 */
export function prepareSocketPath(socket: string) {
  if (!path.isAbsolute(socket))
    throw new Error("The egress socket path must be absolute.");
  if (Buffer.byteLength(socket) > 107)
    throw new Error(`The egress socket path is too long: ${socket}`);
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(socket);
  } catch {
    return;
  }
  if (!st.isSocket())
    throw new Error(`${socket} exists and is not a socket; not replacing it.`);
  fs.unlinkSync(socket);
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The socket path of a sandbox's egress listener under the runner state. */
export function egressSocketPath(stateDir: string, sandboxId: string) {
  return path.join(stateDir, "egress", `${sandboxFileName(sandboxId)}.sock`);
}
