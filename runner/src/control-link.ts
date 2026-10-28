/**
 * The runner link (web plan §1, W-RUN §2): one WebSocket claudex-runner dials
 * to the Claudex service (`/api/v1/claudex/web/runner/link`, sub-protocol
 * `claudex.runner.v1`). The runner token goes in `Authorization: Bearer`;
 * the runner never listens on a port, so it can run behind NAT (the owner's
 * home machine) or next to Go on DC6 (127.0.0.1).
 *
 * - After the socket opens the runner says `hello` (version, the methods it
 *   registered, capacity); Go answers `welcome` with the runner id and the
 *   heartbeat. Go relays browser calls only for methods in that hello.
 * - Both sides ping every heartbeat; a link silent for 2.5 heartbeats is
 *   closed and dialled again. Reconnects back off 1 s → 30 s with jitter
 *   (60 s after the token was refused or another runner took over the id).
 * - `request(op, userId, body)` asks Go for a service (webstore reads and
 *   writes, the user's web key); answers come back as `response` frames.
 *   Requests in flight fail when the link drops; callers retry.
 * - Contexts, engines and running turns survive a dropped link: the tabs
 *   resync through Go once the link is back.
 */
import {
  runnerLinkSubprotocol,
  webCloseCodes,
  webErrorCodes,
  webLimits,
  webPaths,
  webProtocolVersion,
  type WebRpcError,
} from "../../shared/web-protocol";
import {
  parseGoFrame,
  type GoFrame,
  type LinkCapacity,
  type RunnerFrame,
} from "../../shared/web-runner-frames";

/** The socket the link needs (the global WebSocket, or a fake in tests). */
export interface LinkSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (
  url: string,
  init: { protocols: string[]; headers: Record<string, string> },
) => LinkSocket;

/** Node's WebSocket (undici) accepts request headers in its init object. */
export const defaultSocketFactory: SocketFactory = (url, init) => {
  const Socket = (globalThis as { WebSocket?: any }).WebSocket;
  if (!Socket) throw new Error("This Node has no WebSocket (need Node 22+).");
  return new Socket(url, init) as LinkSocket;
};

/** The link URL for the service's base URL (http → ws, https → wss). */
export function linkUrl(serviceUrl: string) {
  const url = new URL(serviceUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("The service URL must be http or https.");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/+$/, "") + webPaths.runnerLink;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** A failed service request, with the code Go gave it. */
export class LinkRequestError extends Error {
  code?: string;
  details?: unknown;
  constructor(error: WebRpcError) {
    super(error.message);
    this.name = "LinkRequestError";
    if (error.code) this.code = error.code;
    if (error.details !== undefined) this.details = error.details;
  }
}

export interface LinkHandlers {
  welcome?(frame: Extract<GoFrame, { t: "welcome" }>): void;
  call(frame: Extract<GoFrame, { t: "call" }>): void;
  cancel?(id: string): void;
  presence?(frame: Extract<GoFrame, { t: "presence" }>): void;
  signedOut?(frame: Extract<GoFrame, { t: "user-signed-out" }>): void;
  drain?(): void;
  /** The link dropped (in-flight requests have failed). */
  down?(): void;
}

export interface ControlLinkOptions {
  serviceUrl: string;
  token: string;
  version: string;
  methods: () => readonly string[];
  capacity: () => LinkCapacity;
  labels?: Record<string, string>;
  handlers: LinkHandlers;
  /** Resident memory and counts for the `load` report. */
  load?: () => { engines: number; users: number; rssMb: number };
  loadIntervalMs?: number;
  socket?: SocketFactory;
  requestTimeoutMs?: number;
  /** How long an open socket may wait for `welcome` (default 2.5 heartbeats). */
  welcomeTimeoutMs?: number;
  /** How long a dial may wait for the socket to open (default 15 s). */
  openTimeoutMs?: number;
  log?: (message: string) => void;
  random?: () => number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * The close code the runner itself closes with. A WebSocket client may only
 * send 1000 or 3000–4999: `goingAway` (1001) makes Node's WebSocket throw.
 */
const clientCloseCode = webCloseCodes.normal;
const baseBackoffMs = 1000;
// At most 5 s between tries: a service restart (a deploy) takes ~30 s, and a
// longer wait left the web without its runner for a minute after it was back.
// One runner dialling every 5 s costs the service nothing.
const maxBackoffMs = 5_000;
const refusedBackoffMs = 60_000;

export class ControlLink {
  private socket?: LinkSocket;
  private open = false;
  private welcomed = false;
  private stopped = true;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private pinger?: NodeJS.Timeout;
  private loader?: NodeJS.Timeout;
  private waitWelcome?: NodeJS.Timeout;
  private waitOpen?: NodeJS.Timeout;
  private lastHeard = 0;
  private heartbeatMs: number = webLimits.heartbeatMs;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private nextDelay?: number;
  /** The id Go gave this runner in its last welcome. */
  runnerId?: string;
  private readonly log: (message: string) => void;
  constructor(private options: ControlLinkOptions) {
    this.log = options.log ?? ((message) => console.error(message));
  }
  /** Up and welcomed: frames reach Go. */
  get connected() {
    return this.open && this.welcomed;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.dial();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.teardown(clientCloseCode, "runner stopping");
  }
  private dial() {
    if (this.stopped) return;
    let socket: LinkSocket;
    try {
      socket = (this.options.socket ?? defaultSocketFactory)(
        linkUrl(this.options.serviceUrl),
        {
          protocols: [runnerLinkSubprotocol],
          headers: { Authorization: `Bearer ${this.options.token}` },
        },
      );
    } catch (error) {
      this.log(
        `claudex-runner: cannot open the link: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.schedule();
      return;
    }
    this.socket = socket;
    // A dial whose socket neither opens nor closes (the service restarting, a
    // lost SYN) would otherwise wait forever: give up and dial again.
    clearTimeout(this.waitOpen);
    this.waitOpen = setTimeout(() => {
      if (this.socket !== socket || this.open) return;
      this.log("claudex-runner: the service did not answer; dialling again");
      this.redial("no answer");
    }, this.options.openTimeoutMs ?? 15_000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.waitOpen);
      this.open = true;
      this.lastHeard = Date.now();
      // An open socket Go never welcomes would otherwise hang forever.
      clearTimeout(this.waitWelcome);
      this.waitWelcome = setTimeout(
        () => {
          if (this.socket !== socket || this.welcomed) return;
          this.log(
            "claudex-runner: the service did not welcome the runner; dialling again",
          );
          this.redial("no welcome");
        },
        this.options.welcomeTimeoutMs ?? webLimits.heartbeatMs * 2.5,
      );
      this.waitWelcome.unref?.();
      this.write({
        t: "hello",
        v: webProtocolVersion,
        version: this.options.version,
        methods: [...this.options.methods()],
        capacity: this.options.capacity(),
        ...(this.options.labels ? { labels: this.options.labels } : {}),
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastHeard = Date.now();
      if (typeof event.data !== "string") {
        this.protocolError("binary frame");
        return;
      }
      let frame: GoFrame;
      try {
        frame = parseGoFrame(event.data);
      } catch (error) {
        this.protocolError(
          error instanceof Error ? error.message : "bad frame",
        );
        return;
      }
      this.receive(frame);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      if (
        event.code === webCloseCodes.runnerRejected ||
        event.code === webCloseCodes.replaced
      ) {
        this.log(
          event.code === webCloseCodes.runnerRejected
            ? "claudex-runner: the service refused the runner token"
            : "claudex-runner: another runner took over this runner id",
        );
        this.nextDelay = refusedBackoffMs;
      }
      this.teardown();
      this.schedule();
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }
  /**
   * Drops the current socket and dials again now-ish, without waiting for a
   * close handshake a dead network may never complete.
   */
  private redial(reason: string) {
    this.teardown(clientCloseCode, reason);
    this.schedule();
  }
  private protocolError(reason: string) {
    this.log(`claudex-runner: protocol error from the service: ${reason}`);
    this.socket?.close(webCloseCodes.protocolError, "protocol error");
  }
  private receive(frame: GoFrame) {
    switch (frame.t) {
      case "welcome":
        clearTimeout(this.waitWelcome);
        this.welcomed = true;
        this.attempt = 0;
        this.runnerId = frame.runnerId;
        this.heartbeatMs = frame.heartbeatMs;
        this.startTimers();
        this.options.handlers.welcome?.(frame);
        return;
      case "call":
        this.options.handlers.call(frame);
        return;
      case "cancel":
        this.options.handlers.cancel?.(frame.id);
        return;
      case "response": {
        const waiting = this.pending.get(frame.id);
        if (!waiting) return;
        this.pending.delete(frame.id);
        clearTimeout(waiting.timer);
        if (frame.ok) waiting.resolve(frame.value);
        else waiting.reject(new LinkRequestError(frame.error!));
        return;
      }
      case "presence":
        this.options.handlers.presence?.(frame);
        return;
      case "user-signed-out":
        this.options.handlers.signedOut?.(frame);
        return;
      case "drain":
        this.options.handlers.drain?.();
        return;
      case "ping":
        this.write({ t: "pong" });
        return;
      case "pong":
        return;
    }
  }
  private startTimers() {
    clearInterval(this.pinger);
    clearInterval(this.loader);
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastHeard > this.heartbeatMs * 2.5) {
        this.log("claudex-runner: the link went silent; dialling again");
        this.redial("silent");
        return;
      }
      this.write({ t: "ping" });
    }, this.heartbeatMs);
    this.pinger.unref?.();
    if (this.options.load) {
      const report = () => {
        const load = this.options.load!();
        this.write({ t: "load", ...load });
      };
      report();
      this.loader = setInterval(report, this.options.loadIntervalMs ?? 30_000);
      this.loader.unref?.();
    }
  }
  private teardown(code?: number, reason?: string) {
    clearInterval(this.pinger);
    clearInterval(this.loader);
    clearTimeout(this.waitWelcome);
    clearTimeout(this.waitOpen);
    this.pinger = this.loader = this.waitWelcome = this.waitOpen = undefined;
    const socket = this.socket;
    this.socket = undefined;
    const wasUp = this.open;
    this.open = this.welcomed = false;
    if (socket && code !== undefined)
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(
        new LinkRequestError({
          message: "The Claudex service is not reachable. Try again.",
          code: webErrorCodes.runnerUnavailable,
        }),
      );
      this.pending.delete(id);
    }
    if (wasUp) this.options.handlers.down?.();
  }
  private schedule() {
    if (this.stopped) return;
    const random = this.options.random ?? Math.random;
    const base =
      this.nextDelay ??
      Math.min(maxBackoffMs, baseBackoffMs * 2 ** this.attempt);
    this.nextDelay = undefined;
    this.attempt++;
    const delay = Math.round(base * (0.8 + random() * 0.4));
    clearTimeout(this.retry);
    // Not unref'd: while the link is down this timer keeps the runner alive.
    this.retry = setTimeout(() => this.dial(), delay);
  }
  private write(frame: RunnerFrame) {
    if (!this.socket || !this.open) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
  /** Sends a frame once Go welcomed this runner; false otherwise. */
  send(frame: RunnerFrame) {
    return this.connected ? this.write(frame) : false;
  }
  /** Asks Go for a service (see webRunnerOps); rejects with LinkRequestError. */
  request(
    op: string,
    userId: number,
    body?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<unknown> {
    if (!this.connected)
      return Promise.reject(
        new LinkRequestError({
          message: "The Claudex service is not reachable. Try again.",
          code: webErrorCodes.runnerUnavailable,
        }),
      );
    const id = `r${(++this.nextId).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new LinkRequestError({
            message: "The Claudex service did not answer in time.",
            code: webErrorCodes.timeout,
          }),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const sent = this.write({
        t: "request",
        id,
        op,
        userId,
        ...(body !== undefined ? { body } : {}),
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new LinkRequestError({
            message: "The Claudex service is not reachable. Try again.",
            code: webErrorCodes.runnerUnavailable,
          }),
        );
      }
    });
  }
}
