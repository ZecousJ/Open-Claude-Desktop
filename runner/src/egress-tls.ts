import http from "node:http";
import net from "node:net";
import { MAX_HELLO_BYTES } from "./egress-support.ts";
import type { ClientHello } from "./egress-proxy.ts";

/**
 * Reads the server name (SNI) from the start of a TLS stream: the
 * ClientHello, which may span several handshake records. `more` means the
 * bytes so far are a valid but incomplete start.
 */
export function parseClientHello(buf: Buffer): ClientHello {
  if (!buf.length) return { kind: "more" };
  if (buf[0] !== 0x16) return { kind: "not-tls" };
  const parts: Buffer[] = [];
  let size = 0;
  let pos = 0;
  let body: Buffer | undefined;
  while (!body) {
    if (pos + 5 > buf.length) return { kind: "more" };
    if (buf[pos] !== 0x16 || buf[pos + 1] !== 0x03) return { kind: "bad" };
    const len = buf.readUInt16BE(pos + 3);
    if (len === 0) return { kind: "bad" };
    if (pos + 5 + len > buf.length) return { kind: "more" };
    parts.push(buf.subarray(pos + 5, pos + 5 + len));
    size += len;
    pos += 5 + len;
    if (size >= 4) {
      const hs = Buffer.concat(parts);
      if (hs[0] !== 0x01) return { kind: "bad" };
      const hsLen = hs.readUIntBE(1, 3);
      if (4 + hsLen > MAX_HELLO_BYTES) return { kind: "bad" };
      if (hs.length >= 4 + hsLen) body = hs.subarray(4, 4 + hsLen);
    }
  }
  let p = 34; // version + random
  const need = (n: number) => p + n <= body!.length;
  if (!need(1)) return { kind: "bad" };
  p += 1 + body[p]!; // session id
  if (!need(2)) return { kind: "bad" };
  p += 2 + body.readUInt16BE(p); // cipher suites
  if (!need(1)) return { kind: "bad" };
  p += 1 + body[p]!; // compression methods
  if (p === body.length) return { kind: "tls" }; // no extensions
  if (!need(2)) return { kind: "bad" };
  const end = p + 2 + body.readUInt16BE(p);
  p += 2;
  if (end > body.length) return { kind: "bad" };
  let serverName: string | undefined;
  while (p < end) {
    if (p + 4 > end) return { kind: "bad" };
    const type = body.readUInt16BE(p);
    const len = body.readUInt16BE(p + 2);
    p += 4;
    if (p + len > end) return { kind: "bad" };
    if (type === 0) {
      if (serverName !== undefined || len < 2) return { kind: "bad" };
      const list = body.subarray(p, p + len);
      if (2 + list.readUInt16BE(0) !== list.length) return { kind: "bad" };
      let q = 2;
      while (q < list.length) {
        if (q + 3 > list.length) return { kind: "bad" };
        const nameType = list[q]!;
        const nameLen = list.readUInt16BE(q + 1);
        q += 3;
        if (q + nameLen > list.length) return { kind: "bad" };
        if (nameType === 0) {
          // Only one host name is allowed (RFC 6066).
          if (serverName !== undefined) return { kind: "bad" };
          serverName = list.subarray(q, q + nameLen).toString("latin1");
        }
        q += nameLen;
      }
      if (serverName === undefined) return { kind: "bad" };
    }
    p += len;
  }
  return serverName === undefined
    ? { kind: "tls" }
    : { kind: "tls", serverName };
}

/**
 * Waits for the client's ClientHello on a freshly opened tunnel. Returns the
 * verdict and every byte read so far (to be forwarded unchanged); the client
 * is left paused.
 */
export function readClientHello(
  client: net.Socket,
  head: Buffer,
  timeoutMs: number,
): Promise<
  | { kind: "tls"; serverName?: string; buffered: Buffer }
  | { kind: "not-tls" | "bad" | "timeout" | "closed" }
> {
  return new Promise((resolve) => {
    let buffered = head;
    let done = false;
    const finish = (
      value:
        | { kind: "tls"; serverName?: string; buffered: Buffer }
        | { kind: "not-tls" | "bad" | "timeout" | "closed" },
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.off("data", onData);
      client.off("close", onClose);
      client.pause();
      resolve(value);
    };
    const check = () => {
      const hello = parseClientHello(buffered);
      if (hello.kind === "tls") finish({ ...hello, buffered });
      else if (hello.kind === "not-tls" || hello.kind === "bad")
        finish({ kind: hello.kind });
      else if (buffered.length > MAX_HELLO_BYTES + 5 * 16)
        finish({ kind: "bad" });
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      check();
    };
    const onClose = () => finish({ kind: "closed" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    client.on("data", onData);
    client.on("close", onClose);
    if (client.destroyed) onClose();
    else check();
  });
}

export function proxyTunnel(
  socketPath: string,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const request = http.request({
      socketPath,
      method: "CONNECT",
      path: authority,
      headers: { Host: authority },
      agent: false,
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("connection timed out")),
      timeoutMs,
    );
    request.once("error", fail);
    request.once("close", () => fail(new Error("error")));
    request.once("connect", (response, socket, head) => {
      if (settled || response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(response.statusMessage || "error"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (head.length) socket.unshift(head);
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
    request.end();
  });
}
