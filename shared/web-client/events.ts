/**
 * The tab's event stream (W-ARCH §3.1, web plan §1.2): one WebSocket to
 * `/api/v1/claudex/web/events`, authorized by a one-time ticket that rides
 * in Sec-WebSocket-Protocol (never in the URL). Go numbers the events; the
 * tab says the last number it applied when it reconnects, and Go replays
 * what it missed from its ring of recent events. When the gap is too old,
 * Go sends the whole state instead and the window re-reads it (`resync`).
 *
 * Reconnects back off from 1 s to 30 s with jitter; a ping every 25 s keeps
 * proxies (Cloudflare drops idle sockets at 100 s) from closing the socket,
 * and a socket that stays silent for two pings is replaced.
 *
 * The desktop app's cloud client (electron/cloud) runs this same stream in
 * its main process.
 */
import type { AppEvent, Snapshot } from "../types";
import {
  eventsSubprotocols,
  parseServerFrame,
  webCloseCodes,
  webEventsSubprotocol,
  webLimits,
  webPaths,
  webProtocolVersion,
  type BrowserFrame,
  type ServerFrame,
} from "../web-protocol";
import type { WebTicketResponse } from "../web-protocol";
import { socketOpen, type SocketLike, type WebEnv } from "./env";
import type { EventHub } from "./hub";

type SignedOutReason = Extract<AppEvent, { type: "signed-out" }>["reason"];
const signedOutReasons: readonly string[] = [
  "revoked",
  "device-revoked",
  "session-expired",
  "password-changed",
];

export const reconnectBaseMs = 1_000;
export const reconnectMaxMs = 30_000;
/** Waits after a "no capacity" close before trying again. */
export const unavailableRetryMs = 5_000;
/** A non-resumed `ready` waits this long for a `snapshot` frame. */
const resyncDelayMs = 100;

/** What the stream needs of the sign-in session (WebAuth, or the desktop's). */
export interface StreamAuth {
  /** Whether a session is open (a failed ticket then means "try later"). */
  readonly current: unknown;
  ticket(): Promise<Pick<WebTicketResponse, "ticket">>;
  expire(reason: SignedOutReason, message?: string): void;
}

export type StreamEnv = Pick<
  WebEnv,
  | "origin"
  | "openSocket"
  | "timers"
  | "now"
  | "navigate"
  | "onVisibility"
  | "onOnline"
>;

export interface StreamHooks {
  /** Whether the window has read the snapshot (a fresh stream then resyncs). */
  snapshotLoaded(): boolean;
  /** The last event number the window's snapshot holds, when known. */
  snapshotSeq?(): number | undefined;
  /** The state a `snapshot` frame carried, for the window's next read. */
  pushSnapshot(snapshot: Snapshot): void;
  /** Sees every event before the window does (caches). */
  observe(event: AppEvent): void;
  intercept?(event: AppEvent): boolean;
  /** A connected device's dispatch notification, for the page to show. */
  dispatchNotification?(
    event: Extract<AppEvent, { type: "device-event" }>,
  ): void;
}

export class EventStream {
  private socket?: SocketLike;
  /** Bumped on every connect and stop; stale sockets and tickets are ignored. */
  private generation = 0;
  private attempts = 0;
  private retryTimer?: unknown;
  private pingTimer?: unknown;
  private resyncTimer?: unknown;
  private lastMessageAt = 0;
  private running = false;
  private errorFrame?: { code: string; message: string };
  private visible = true;
  private focused = true;
  /** Seq of the last event this tab applied. */
  lastSeq?: number;
  /** Whether a `ready` frame arrived on the current socket. */
  ready = false;
  /** The window was told the stream is down (`stream-connection`). */
  private lost = false;

  constructor(
    private env: StreamEnv,
    private auth: StreamAuth,
    private hub: EventHub,
    private hooks: StreamHooks,
    private tabId: string,
  ) {
    env.onVisibility((visible, focused) => {
      this.visible = visible;
      this.focused = focused;
      this.send({ t: "presence", visible, focused });
    });
    env.onOnline(() => {
      if (this.running && !this.socket) this.connectNow();
    });
  }

  get connected() {
    return this.ready;
  }

  /** Opens the stream (signed in); no-op when it is already running. */
  start() {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    this.connectNow();
  }

  /** Closes the stream (signed out, page hidden for good). */
  stop() {
    this.running = false;
    this.generation++;
    this.lastSeq = undefined;
    this.lost = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    if (socket) {
      socket.onclose = socket.onmessage = socket.onopen = socket.onerror = null;
      try {
        socket.close(webCloseCodes.normal, "signed out");
      } catch {
        /* already closed */
      }
    }
  }

  private clearTimers() {
    const { timers } = this.env;
    timers.clearTimeout(this.retryTimer);
    timers.clearInterval(this.pingTimer);
    timers.clearTimeout(this.resyncTimer);
    this.retryTimer = this.pingTimer = this.resyncTimer = undefined;
  }

  private connectNow() {
    this.env.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    void this.connect();
  }

  private url() {
    const origin = new URL(this.env.origin);
    const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${origin.host}${webPaths.events}`;
  }

  private async connect() {
    const generation = ++this.generation;
    this.ready = false;
    this.errorFrame = undefined;
    let ticket: string;
    try {
      ticket = (await this.auth.ticket()).ticket;
    } catch {
      if (generation !== this.generation) return;
      // Signed out meanwhile (the auth client told the window); otherwise
      // the service is unreachable: try again later.
      if (!this.auth.current) this.stop();
      else this.retry();
      return;
    }
    if (generation !== this.generation || !this.running) return;
    let socket: SocketLike;
    try {
      socket = this.env.openSocket(this.url(), eventsSubprotocols(ticket));
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    const current = () =>
      generation === this.generation && this.socket === socket;
    socket.onopen = () => {
      if (!current()) return;
      if (socket.protocol && socket.protocol !== webEventsSubprotocol) {
        socket.close(webCloseCodes.protocolError, "unexpected protocol");
        return;
      }
      this.lastMessageAt = this.env.now();
      this.send({
        t: "hello",
        v: webProtocolVersion,
        tabId: this.tabId,
        ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}),
      });
      this.send({
        t: "presence",
        visible: this.visible,
        focused: this.focused,
      });
      this.pingTimer = this.env.timers.setInterval(
        () => this.ping(socket),
        webLimits.heartbeatMs,
      );
    };
    socket.onmessage = (message) => {
      if (!current()) return;
      this.lastMessageAt = this.env.now();
      if (typeof message.data !== "string") return;
      let frame: ServerFrame;
      try {
        frame = parseServerFrame(message.data);
      } catch (error) {
        console.error(
          "Ignored a malformed event frame:",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      this.frame(frame);
    };
    socket.onerror = () => {
      /* onclose follows with the code. */
    };
    socket.onclose = (event) => {
      if (!current()) return;
      this.closed(event.code);
    };
  }

  private ping(socket: SocketLike) {
    if (socket !== this.socket) return;
    const silent = this.env.now() - this.lastMessageAt;
    if (silent > webLimits.heartbeatMs * 2 + 5_000) {
      // A dead connection the browser has not noticed: replace it.
      this.drop();
      return;
    }
    this.send({ t: "ping" });
  }

  /** Closes the current socket and reconnects. */
  private drop() {
    const socket = this.socket;
    if (!socket) return;
    socket.onclose = socket.onmessage = socket.onopen = socket.onerror = null;
    try {
      socket.close(webCloseCodes.normal, "reconnecting");
    } catch {
      /* already closed */
    }
    this.closed(webCloseCodes.goingAway);
  }

  private send(frame: BrowserFrame) {
    const socket = this.socket;
    if (!socket || socket.readyState !== socketOpen) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* the close handler reconnects */
    }
  }

  private scheduleResync(delay: number) {
    this.env.timers.clearTimeout(this.resyncTimer);
    this.resyncTimer = this.env.timers.setTimeout(() => {
      this.resyncTimer = undefined;
      this.hub.emit({ type: "resync" });
    }, delay);
  }

  private frame(frame: ServerFrame) {
    switch (frame.t) {
      case "ready": {
        this.ready = true;
        this.attempts = 0;
        if (this.lost) {
          this.lost = false;
          this.hub.emit({ type: "stream-connection", connected: true });
        }
        const reconnecting = this.lastSeq !== undefined;
        if (!frame.resumed) {
          this.lastSeq = frame.seq;
          // Events may have been missed: after a reconnect, or when the
          // window read its snapshot before the stream was up — unless that
          // snapshot already holds every event up to where the stream
          // starts (Go numbers both).
          const covered = this.hooks.snapshotSeq?.() === frame.seq;
          if (reconnecting || (this.hooks.snapshotLoaded() && !covered))
            this.scheduleResync(resyncDelayMs);
        }
        return;
      }
      case "event": {
        if (this.lastSeq !== undefined && frame.seq <= this.lastSeq) return;
        const gap = this.lastSeq !== undefined && frame.seq > this.lastSeq + 1;
        this.lastSeq = frame.seq;
        this.deliver(frame.event);
        if (gap) this.scheduleResync(0);
        return;
      }
      case "snapshot":
        this.lastSeq = frame.seq;
        this.hooks.pushSnapshot(frame.snapshot);
        this.scheduleResync(0);
        return;
      case "open-url":
        if (frame.target === "same-tab") this.env.navigate(frame.url);
        else
          // A new tab needs a click: the window asks before opening it.
          this.deliver({
            type: "external-link",
            url: new URL(frame.url, this.env.origin).href,
          });
        return;
      case "error":
        this.errorFrame = { code: frame.code, message: frame.message };
        return;
      case "pong":
        return;
    }
  }

  private deliver(event: AppEvent) {
    if (
      event.type === "device-event" &&
      event.event.type === "dispatch-notification"
    )
      this.hooks.dispatchNotification?.(event);
    if (this.hooks.intercept?.(event)) return;
    if (event.type === "signed-out") {
      // The auth client ends the session everywhere and tells the window.
      this.auth.expire(event.reason, event.message);
      return;
    }
    this.hooks.observe(event);
    this.hub.emit(event);
  }

  private closed(code: number) {
    this.socket = undefined;
    this.ready = false;
    const { timers } = this.env;
    timers.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (!this.running) return;
    const error = this.errorFrame;
    this.errorFrame = undefined;
    if (code === webCloseCodes.signedOut) {
      const reason = (
        error && signedOutReasons.includes(error.code) ? error.code : "revoked"
      ) as SignedOutReason;
      this.stop();
      this.auth.expire(reason, error?.message);
      return;
    }
    if (code === webCloseCodes.forbidden) {
      this.stop();
      this.auth.expire(
        "revoked",
        error?.message ||
          "Claudex on the web isn't available for your account.",
      );
      return;
    }
    if (code === webCloseCodes.badTicket && this.attempts === 0) {
      // A ticket that expired in transit: one quick retry with a new one.
      this.attempts++;
      this.retryTimer = timers.setTimeout(() => this.connectNow(), 250);
      return;
    }
    // A running reply can't arrive until the stream is back: the window
    // says so under it (Connection lost, Check now).
    if (!this.lost) {
      this.lost = true;
      this.hub.emit({ type: "stream-connection", connected: false });
    }
    this.retry(code === webCloseCodes.unavailable ? unavailableRetryMs : 0);
  }

  private retry(minimum = 0) {
    if (!this.running) return;
    const exponential = Math.min(
      reconnectMaxMs,
      reconnectBaseMs * 2 ** Math.min(this.attempts, 10),
    );
    this.attempts++;
    // ±20% so the tabs of a restarted server do not return at once.
    const jitter = exponential * (0.8 + Math.random() * 0.4);
    const delay = Math.min(reconnectMaxMs, Math.max(minimum, jitter));
    this.env.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.env.timers.setTimeout(
      () => this.connectNow(),
      delay,
    );
  }
}
