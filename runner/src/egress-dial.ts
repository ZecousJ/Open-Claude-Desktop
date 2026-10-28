import http from "node:http";
import net from "node:net";
import { type DenyReason, type Verdict } from "./net-policy.ts";
import { resolveAllowed } from "./net-policy-compile.ts";
import { readClientHello, proxyTunnel } from "./egress-tls.ts";
import {
  HOP_BY_HOP,
  parseAuthority,
  refusal,
  withTimeout,
} from "./egress-support.ts";
import type { EgressProxy } from "./egress-proxy.ts";
import type { Session } from "./egress-proxy.ts";

/**
 * Checks a target and opens a connection to one of its checked addresses.
 * Resolves to the connected socket or to a refusal.
 */
export async function dial(
  this: EgressProxy,
  session: Session,
  rawHost: string,
  port: number,
): Promise<
  | { ok: true; upstream: net.Socket; host: string }
  | {
      ok: false;
      status: number;
      reason: DenyReason | "error";
      message: string;
    }
> {
  if (session.closed)
    return {
      ok: false,
      status: 503,
      reason: "error",
      message: "The sandbox is closing.",
    };
  if (this.exhausted(session))
    return { ok: false, ...this.deny(session, rawHost, port, "allowance") };
  if (session.open.size >= this.maxConnections)
    return {
      ok: false,
      status: 503,
      reason: "error",
      message: "Too many open connections from this sandbox.",
    };
  const verdict = session.compiled.checkHost(rawHost, port);
  if (!verdict.ok)
    return {
      ok: false,
      ...this.deny(session, rawHost, port, verdict.reason),
    };
  const host = verdict.host!;
  const policyAtCheck = session.compiled;
  const resolved = await withTimeout(
    resolveAllowed(policyAtCheck, host, this.resolver),
    this.resolveTimeoutMs,
    { ok: false as const, reason: "unresolved" as DenyReason },
  );
  if (!resolved.ok)
    return { ok: false, ...this.deny(session, host, port, resolved.reason) };
  let lastError = "";
  for (const address of resolved.addresses) {
    // The policy may have changed while resolving.
    if (session.closed || session.compiled !== policyAtCheck) {
      const again = session.compiled.checkHost(host, port);
      if (!again.ok)
        return { ok: false, ...this.deny(session, host, port, again.reason) };
      const addr = session.compiled.checkResolved(address);
      if (!addr.ok)
        return { ok: false, ...this.deny(session, host, port, addr.reason) };
    }
    try {
      const upstream = this.upstreamSocket
        ? await proxyTunnel(
            this.upstreamSocket,
            host,
            port,
            this.connectTimeoutMs,
          )
        : await this.connectTo(address, port);
      if (session.closed || session.compiled !== policyAtCheck) {
        const current = session.compiled.checkHost(host, port);
        const resolved = session.compiled.checkResolved(address);
        if (session.closed || !current.ok || !resolved.ok) {
          upstream.destroy();
          return {
            ok: false,
            ...this.deny(
              session,
              host,
              port,
              !current.ok
                ? current.reason
                : !resolved.ok
                  ? resolved.reason
                  : "network-off",
            ),
          };
        }
      }
      // Re-check what the socket actually reached.
      const peer = upstream.remoteAddress ?? "";
      const check: Verdict = this.verifyPeer
        ? session.compiled.checkResolved(peer)
        : { ok: true };
      if (!check.ok) {
        upstream.destroy();
        return { ok: false, ...this.deny(session, host, port, check.reason) };
      }
      session.usage.allowed++;
      return { ok: true, upstream, host };
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  this.log(`egress ${session.id}: ${host}:${port} unreachable (${lastError})`);
  return {
    ok: false,
    status: 502,
    reason: "error",
    message: `${host}:${port} could not be reached.`,
  };
}

export function connectTo(
  this: EgressProxy,
  address: string,
  port: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = this.connectUpstream(address, port);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connection timed out"));
    }, this.connectTimeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      // Until the caller wires it up, an error only ends the socket.
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
  });
}

export function track(
  this: EgressProxy,
  session: Session,
  upstream: net.Socket,
  client: net.Socket,
  host: string,
  port: number,
  tunnel: boolean,
) {
  session.open.set(upstream, { host, port, client });
  // Errors and idle time end both sides at once; a normal close lets the
  // other side finish writing what it already has (end, not destroy).
  const abort = () => {
    session.open.delete(upstream);
    upstream.destroy();
    client.destroy();
  };
  upstream.setTimeout(this.idleTimeoutMs, abort);
  client.setTimeout(this.idleTimeoutMs, abort);
  upstream.on("error", abort);
  client.on("error", abort);
  upstream.on("close", () => {
    session.open.delete(upstream);
    if (tunnel) client.end();
  });
  client.on("close", () => {
    session.open.delete(upstream);
    upstream.destroy();
  });
}

export async function onConnect(
  this: EgressProxy,
  session: Session,
  req: http.IncomingMessage,
  client: net.Socket,
  head: Buffer,
) {
  client.on("error", () => client.destroy());
  const target = parseAuthority(req.url ?? "");
  if (!target) {
    session.usage.denied++;
    client.end(refusal(400, "bad-host", "CONNECT needs host:port."));
    return;
  }
  const result = await this.dial(session, target.host, target.port);
  if (!result.ok) {
    if (client.writable)
      client.end(refusal(result.status, result.reason, result.message));
    else client.destroy();
    return;
  }
  const { upstream } = result;
  if (client.destroyed) {
    upstream.destroy();
    return;
  }
  this.track(session, upstream, client, result.host, target.port, true);
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let first = head;
  if (session.compiled.level !== "full") {
    // A tunnel is one TCP connection to a checked address, but the server
    // behind a shared address (a CDN) picks the site from the TLS server
    // name. Below `full` the tunnel must carry TLS whose server name the
    // policy allows too, or an allowed name would front for any other
    // site on the same CDN (including the Claudex service itself).
    const hello = await readClientHello(client, head, this.helloTimeoutMs);
    const stop = () => {
      session.usage.allowed--;
      session.open.delete(upstream);
      upstream.destroy();
      client.destroy();
    };
    if (hello.kind !== "tls") {
      this.deny(session, result.host, target.port, "not-allowed");
      this.log(
        `egress ${session.id}: tunnel to ${result.host}:${target.port} did not start with a TLS ClientHello (${hello.kind})`,
      );
      stop();
      return;
    }
    if (hello.serverName !== undefined) {
      const verdict = session.compiled.checkHost(hello.serverName, target.port);
      if (!verdict.ok) {
        this.deny(session, hello.serverName, target.port, verdict.reason);
        stop();
        return;
      }
    }
    if (session.closed || client.destroyed) {
      stop();
      return;
    }
    // A later policy change re-checks the name the tunnel really serves.
    const entry = session.open.get(upstream);
    if (entry && hello.serverName !== undefined) entry.host = hello.serverName;
    first = hello.buffered;
  }
  if (first.length) {
    this.count(session, "bytesOut", first.length);
    upstream.write(first);
  }
  client.on("data", (chunk: Buffer) =>
    this.count(session, "bytesOut", chunk.length),
  );
  upstream.on("data", (chunk: Buffer) =>
    this.count(session, "bytesIn", chunk.length),
  );
  client.pipe(upstream);
  upstream.pipe(client);
}

export async function onRequest(
  this: EgressProxy,
  session: Session,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const fail = (status: number, reason: string, message: string) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Claudex-Egress": reason,
      Connection: "close",
    });
    res.end(`${message}\n`);
  };
  let url: URL;
  try {
    url = new URL(req.url ?? "");
  } catch {
    session.usage.denied++;
    fail(400, "bad-host", "The proxy only forwards absolute http:// requests.");
    return;
  }
  if (url.protocol !== "http:") {
    session.usage.denied++;
    fail(400, "bad-host", "Use CONNECT for https:// and other protocols.");
    return;
  }
  const port = url.port ? Number(url.port) : 80;
  const result = await this.dial(session, url.hostname, port);
  if (!result.ok) {
    req.resume();
    fail(result.status, result.reason, result.message);
    return;
  }
  const { upstream, host } = result;
  this.track(session, upstream, req.socket, host, port, false);
  const headers: http.OutgoingHttpHeaders = {};
  const listed = new Set(
    String(req.headers.connection ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(req.headers))
    if (!HOP_BY_HOP.has(name) && !listed.has(name) && value !== undefined)
      headers[name] = value;
  headers.host = url.host;
  headers.connection = "close";
  const forward = http.request({
    // The connection is the one dial() checked; no agent, no new lookup.
    // (With `agent: false` Node ignores createConnection, so it is unset.)
    createConnection: () => upstream,
    host: upstream.remoteAddress,
    port,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers,
    setHost: false,
  });
  forward.on("error", () =>
    fail(502, "error", `${host}:${port} could not be reached.`),
  );
  forward.on("response", (response) => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(response.headers))
      if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value;
    out.connection = "close";
    res.writeHead(response.statusCode ?? 502, response.statusMessage, out);
    response.on("data", (chunk: Buffer) =>
      this.count(session, "bytesIn", chunk.length),
    );
    response.pipe(res);
  });
  req.on("data", (chunk: Buffer) =>
    this.count(session, "bytesOut", chunk.length),
  );
  req.pipe(forward);
}
