// The runner's egress proxy (web plan W-RUN 4.2, 12.2, 12.4).
//
// Sandboxes have their own network namespace with no interface but loopback.
// The one way out is an HTTP proxy the runner serves on a Unix socket per
// sandbox; the driver binds that socket into the sandbox and bridges it to
// 127.0.0.1:3128 there (HTTPS_PROXY / HTTP_PROXY point at it). bwrap binds the
// socket file (sandbox/bwrap.ts); runsc can bind the same file, or the proxy
// can listen on an address inside the sandbox's network namespace.
//
// For every request the proxy
//   - checks the host name and port against the sandbox's NetPolicy,
//   - resolves the name itself (the sandbox has no DNS) and refuses the whole
//     name when any answer is a private, internal or denied address,
//   - connects only to an address it just checked (no second lookup, so DNS
//     rebinding cannot swap the target), and checks the connected peer again,
//   - counts the bytes moved and stops the session at its allowance.
//
// It speaks CONNECT (HTTPS, git over HTTPS, anything TLS) and absolute-form
// plain HTTP (http://…) requests. Nothing is decrypted or inspected.
//
// Erasable TypeScript only (no enums, no parameter properties).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  isIpLiteral,
  ownAddresses,
  type CompiledPolicy,
  type DenyReason,
  type NetPolicy,
  type Verdict,
} from "./net-policy.ts";
import {
  compilePolicy,
  denyMessage,
  systemResolver,
  type Resolver,
} from "./net-policy-compile.ts";
import { refusal, statusFor, prepareSocketPath } from "./egress-support.ts";
import * as egressDial from "./egress-dial.ts";
import { installMethods } from "./install-methods.ts";

export interface EgressProxyOptions {
  upstreamSocket?: string;
  /** Name resolution (default: the system resolver). */
  resolver?: Resolver;
  /** Addresses that are always refused besides the policy's (default: this host's). */
  ownAddresses?: () => string[];
  /** Opens the upstream TCP connection (tests replace it). */
  connect?: (address: string, port: number) => net.Socket;
  log?: (line: string) => void;
  /** Resolution limit (default 5 s). */
  resolveTimeoutMs?: number;
  /** Upstream connection limit (default 10 s). */
  connectTimeoutMs?: number;
  /** Idle connections are closed after this (default 10 min). */
  idleTimeoutMs?: number;
  /** Open connections per sandbox (default 256). */
  maxConnections?: number;
  /**
   * Checks the connected peer address again (default true). Only tests that
   * point `connect` at a local server turn it off.
   */
  verifyPeer?: boolean;
  /**
   * The allowance (NetPolicy.maxBytes) applies per window of this length
   * (default 24 h): a runner keeps one listener per sandbox for as long as
   * the sandbox exists, so a lifetime cap would lock a user out for good.
   */
  allowanceWindowMs?: number;
  /** Clock (tests). */
  now?: () => number;
  /**
   * How long a tunnel below `full` may take to send its TLS ClientHello
   * (default 10 s).
   */
  helloTimeoutMs?: number;
}

/** Where a sandbox's proxy listens: a Unix socket file or a TCP address. */
export type EgressListen = { socket: string } | { host: string; port: number };

export interface EgressUsage {
  bytesIn: number;
  bytesOut: number;
  connections: number;
  allowed: number;
  denied: number;
}

export interface EgressHandle {
  readonly id: string;
  /** The Unix socket path, when listening on one. */
  readonly socket?: string;
  /** Resolves once the listener is bound. */
  readonly ready: Promise<void>;
  policy(): NetPolicy;
  /** Replaces the policy; open connections the new one refuses are closed. */
  update(policy: NetPolicy): void;
  usage(): EgressUsage;
  close(): Promise<void>;
}

export interface Session {
  id: string;
  compiled: CompiledPolicy;
  usage: EgressUsage;
  /** Bytes counted against the allowance in the current window. */
  windowBytes: number;
  windowStart: number;
  /** Inode of the bound socket file, so close never removes a successor's. */
  inode?: number;
  /** Open upstream sockets and the target each was allowed for. */
  open: Map<net.Socket, { host: string; port: number; client: net.Socket }>;
  server: http.Server;
  socket?: string;
  closed: boolean;
}

/**
 * One proxy for all sandboxes of a runner; each sandbox gets its own listener
 * so the listener itself says which policy applies (no credentials involved).
 */
export class EgressProxy {
  private readonly sessions = new Map<string, Session>();
  readonly resolver: Resolver;
  private readonly own: () => string[];
  readonly connectUpstream: (address: string, port: number) => net.Socket;
  readonly log: (line: string) => void;
  readonly resolveTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxConnections: number;
  readonly verifyPeer: boolean;
  private readonly allowanceWindowMs: number;
  private readonly now: () => number;
  readonly helloTimeoutMs: number;
  readonly upstreamSocket?: string;

  constructor(options: EgressProxyOptions = {}) {
    this.upstreamSocket = options.upstreamSocket;
    this.resolver = options.resolver ?? systemResolver;
    this.own = options.ownAddresses ?? ownAddresses;
    this.connectUpstream =
      options.connect ??
      ((address, port) => net.connect({ host: address, port }));
    this.log = options.log ?? (() => {});
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? 5_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.maxConnections = options.maxConnections ?? 256;
    this.verifyPeer = !options.upstreamSocket && (options.verifyPeer ?? true);
    this.allowanceWindowMs = options.allowanceWindowMs ?? 24 * 3_600_000;
    this.now = options.now ?? Date.now;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  }

  /** The handle of an open sandbox listener. */
  get(id: string): EgressHandle | undefined {
    const session = this.sessions.get(id);
    return session ? this.handle(session, Promise.resolve()) : undefined;
  }

  /**
   * Starts (or, for a known id, re-uses and updates) the listener of one
   * sandbox. The Unix socket is bound before this returns, so a launcher
   * prepared right after can bind it into the sandbox; `ready` reports
   * listen errors.
   */
  open(id: string, policy: NetPolicy, listen: EgressListen): EgressHandle {
    const existing = this.sessions.get(id);
    if (existing && !existing.closed) {
      const socket = "socket" in listen ? listen.socket : undefined;
      if (socket === existing.socket) {
        this.apply(existing, policy);
        return this.handle(existing, Promise.resolve());
      }
      void this.closeSession(existing);
    }
    const compiled = compilePolicy(policy, this.own());
    const server = http.createServer();
    const session: Session = {
      id,
      compiled,
      usage: { bytesIn: 0, bytesOut: 0, connections: 0, allowed: 0, denied: 0 },
      open: new Map(),
      server,
      closed: false,
      windowBytes: 0,
      windowStart: this.now(),
    };
    server.on(
      "connect",
      (req, client, head) =>
        void this.onConnect(session, req, client as net.Socket, head),
    );
    server.on("request", (req, res) => void this.onRequest(session, req, res));
    server.on("upgrade", (_req, client: net.Socket) =>
      client.end(
        refusal(
          501,
          "error",
          "Use CONNECT for upgraded connections through the proxy.",
        ),
      ),
    );
    server.on("clientError", (_error, client: net.Socket) => {
      if (client.writable)
        client.end(
          refusal(400, "bad-host", "The proxy could not read the request."),
        );
      else client.destroy();
    });
    server.headersTimeout = 30_000;
    server.requestTimeout = 0;
    let ready: Promise<void>;
    if ("socket" in listen) {
      const socket = listen.socket;
      session.socket = socket;
      prepareSocketPath(socket);
      // Bind under a temporary name, then rename into place: Node removes a
      // listener's path when it closes, and must not remove the file of a
      // successor bound to the same path (the rename makes that removal a
      // no-op). The rename is atomic, so the path is never missing.
      const temp = path.join(
        path.dirname(socket),
        `.e${crypto.randomBytes(6).toString("hex")}`,
      );
      if (Buffer.byteLength(temp) > 107)
        throw new Error(`The egress socket directory is too long: ${socket}`);
      const place = () => {
        if (session.inode !== undefined) return;
        fs.chmodSync(temp, 0o600);
        const ino = fs.lstatSync(temp).ino;
        fs.renameSync(temp, socket);
        session.inode = ino;
      };
      ready = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(temp, () => {
          server.off("error", reject);
          try {
            place();
            resolve();
          } catch (error) {
            reject(error as Error);
          }
        });
      });
      // Node binds a Unix socket synchronously; place it now so a launcher
      // prepared right after open() finds it.
      try {
        place();
      } catch {}
    } else {
      ready = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: listen.host, port: listen.port }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    }
    ready.catch((error: Error) =>
      this.log(`egress ${id}: cannot listen: ${error.message}`),
    );
    this.sessions.set(id, session);
    return this.handle(session, ready);
  }

  /** Closes one sandbox's listener and its connections. */
  async close(id: string) {
    const session = this.sessions.get(id);
    if (session) await this.closeSession(session);
  }

  async closeAll() {
    await Promise.all(
      [...this.sessions.values()].map((s) => this.closeSession(s)),
    );
  }

  private handle(session: Session, ready: Promise<void>): EgressHandle {
    return {
      id: session.id,
      ...(session.socket ? { socket: session.socket } : {}),
      ready,
      policy: () => session.compiled.source,
      update: (policy) => this.apply(session, policy),
      usage: () => ({ ...session.usage, connections: session.open.size }),
      close: () => this.closeSession(session),
    };
  }

  private apply(session: Session, policy: NetPolicy) {
    session.compiled = compilePolicy(policy, this.own());
    // Connections the new policy would not open are closed now.
    for (const [upstream, target] of session.open) {
      const verdict = session.compiled.checkHost(target.host, target.port);
      const peer = upstream.remoteAddress;
      const address: Verdict =
        peer && this.verifyPeer
          ? isIpLiteral(target.host)
            ? session.compiled.checkAddress(peer)
            : session.compiled.checkResolved(peer)
          : { ok: true };
      if (!verdict.ok || !address.ok) {
        upstream.destroy();
        target.client.destroy();
      }
    }
  }

  private async closeSession(session: Session) {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.id) === session)
      this.sessions.delete(session.id);
    for (const [upstream, target] of session.open) {
      upstream.destroy();
      target.client.destroy();
    }
    session.open.clear();
    session.server.closeAllConnections?.();
    await new Promise<void>((resolve) => session.server.close(() => resolve()));
    // Remove the file unless a successor listens on the same path (inode
    // numbers can be reused at once on tmpfs, so they alone do not tell).
    const successor = [...this.sessions.values()].some(
      (other) => other.socket === session.socket && !other.closed,
    );
    if (session.socket && !successor)
      try {
        const st = fs.lstatSync(session.socket);
        if (st.isSocket() && st.ino === session.inode)
          fs.unlinkSync(session.socket);
      } catch {}
    const u = session.usage;
    this.log(
      `egress ${session.id}: closed (${u.allowed} allowed, ${u.denied} refused, ${u.bytesIn + u.bytesOut} bytes)`,
    );
  }

  deny(session: Session, host: string, port: number, reason: DenyReason) {
    session.usage.denied++;
    this.log(`egress ${session.id}: refused ${host}:${port} (${reason})`);
    return {
      status: statusFor(reason),
      reason,
      message: denyMessage(reason, host, port),
    };
  }

  exhausted(session: Session) {
    const now = this.now();
    if (now - session.windowStart >= this.allowanceWindowMs) {
      session.windowStart = now;
      session.windowBytes = 0;
    }
    return session.windowBytes >= session.compiled.maxBytes;
  }

  /** Account bytes; at the allowance every connection of the session stops. */
  count(session: Session, direction: "bytesIn" | "bytesOut", n: number) {
    session.usage[direction] += n;
    session.windowBytes += n;
    if (!this.exhausted(session)) return;
    this.log(`egress ${session.id}: network allowance used up`);
    for (const [upstream, target] of session.open) {
      upstream.destroy();
      target.client.destroy();
    }
  }
}

export interface EgressProxy {
  dial: OmitThisParameter<typeof egressDial.dial>;
  connectTo: OmitThisParameter<typeof egressDial.connectTo>;
  track: OmitThisParameter<typeof egressDial.track>;
  onConnect: OmitThisParameter<typeof egressDial.onConnect>;
  onRequest: OmitThisParameter<typeof egressDial.onRequest>;
}
installMethods(EgressProxy.prototype, egressDial);

export type ClientHello =
  | { kind: "tls"; serverName?: string }
  | { kind: "more" }
  | { kind: "not-tls" }
  | { kind: "bad" };
