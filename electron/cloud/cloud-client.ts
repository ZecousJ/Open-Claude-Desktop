/**
 * The desktop app's client of its cloud conversations (docs/cloud-sync.md
 * P3). Chat, Cowork and GitHub Code conversations live on the user's runner
 * like the web version's, so the desktop talks to them the way a browser tab
 * does: bridge calls go to `POST /api/v1/claudex/web/rpc/<method>`, events
 * come over the tab's WebSocket, large bytes go through uploads. It runs the
 * web bridge's own transport, codec and event stream (shared/web-client) in the
 * main process; only the session differs: the desktop's signed-in account
 * token, which the relay accepts like a web session's (P2).
 */
import type { AppEvent, Snapshot } from "../../shared/types";
import {
  parseTicketResponse,
  webAuthRoutes,
  webHeaders,
  webPaths,
} from "../../shared/web-protocol";
import { encodeCall } from "../../shared/web-client/codec";
import type { SocketFactory, Timers } from "../../shared/web-client/env";
import {
  apiError,
  apiValue,
  bridgeError,
  messages,
  offlineError,
  readJson,
  statusOf,
} from "../../shared/web-client/errors";
import { EventStream } from "../../shared/web-client/events";
import { EventHub } from "../../shared/web-client/hub";
import { WebTransport } from "../../shared/web-client/transport";

type SignedOutReason = Extract<AppEvent, { type: "signed-out" }>["reason"];

/** What the client needs of the desktop's account session (RemoteSession). */
export interface CloudSession {
  /** The access token, renewed when it is about to expire. */
  currentToken(): Promise<string>;
  /**
   * A new access token after `stale` was refused. Throws when the service
   * refused the refresh (the session ended; RemoteSession signs out).
   */
  renewed(stale: string): Promise<string>;
}

export interface CloudClientOptions {
  /** The Claudex service's origin, e.g. "https://claudex.example.com". */
  baseUrl: string;
  /** The signed-in account's session; undefined while signed out. */
  session(): CloudSession | undefined;
  /** The service ended the session on the cloud side. */
  signedOut?(reason: SignedOutReason, message?: string): void;
  /** Opens an address the runner asked for (a payment page). */
  openUrl?(url: string): void;
  /** Reports whether a window shows and has focus (runner notifications). */
  onVisibility?(listener: (visible: boolean, focused: boolean) => void): void;
  /** Called when the network comes back (system resume). */
  onOnline?(listener: () => void): void;
  randomId(): string;
  fetch?: typeof fetch;
  openSocket?: SocketFactory;
  timers?: Timers;
  now?(): number;
}

const nodeTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval> | undefined),
};

/** A cloud snapshot and the last event number it holds, when Go said it. */
export interface CloudSnapshot {
  snapshot: Snapshot;
  eventSeq?: number;
}

export class CloudClient {
  private readonly hub = new EventHub();
  private readonly transport: WebTransport;
  private readonly stream: EventStream;
  private readonly origin: string;
  private readonly tabId: string;
  private loadedSeq?: number;
  private loaded = false;
  private pushed?: Snapshot;

  constructor(private options: CloudClientOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.tabId = options.randomId();
    const request = options.fetch ?? fetch;
    const timers = options.timers ?? nodeTimers;
    const now = options.now ?? Date.now;
    const auth = {
      get current() {
        return options.session();
      },
      accessToken: async () => {
        const session = options.session();
        if (!session)
          throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
        return session.currentToken();
      },
      refresh: async (stale?: string) => {
        const session = options.session();
        if (!session) return null;
        try {
          return { accessToken: await session.renewed(stale ?? "") };
        } catch (error) {
          if (statusOf(error) === 401) return null;
          throw error;
        }
      },
      expire: (reason: SignedOutReason, message?: string) => {
        this.stop();
        options.signedOut?.(reason, message);
      },
      ticket: () => this.ticket(),
    };
    this.transport = new WebTransport(
      {
        fetch: (input, init) =>
          request(new URL(String(input), this.origin), init),
        timers,
      },
      auth,
      this.tabId,
    );
    this.stream = new EventStream(
      {
        origin: this.origin,
        openSocket:
          options.openSocket ??
          ((url, protocols) =>
            new WebSocket(
              url,
              protocols,
            ) as unknown as ReturnType<SocketFactory>),
        timers,
        now,
        navigate: (url) => options.openUrl?.(new URL(url, this.origin).href),
        onVisibility: (listener) => options.onVisibility?.(listener),
        onOnline: (listener) => options.onOnline?.(listener),
      },
      auth,
      this.hub,
      {
        snapshotLoaded: () => this.loaded,
        snapshotSeq: () => this.loadedSeq,
        pushSnapshot: (snapshot) => {
          this.pushed = snapshot;
        },
        observe: () => {},
      },
      this.tabId,
    );
  }

  /**
   * A one-time events ticket (`auth/events-ticket`). The route sits beside
   * the web sign-in routes, so it takes the web app's CSRF headers.
   */
  private async ticket() {
    const send = async (token: string) => {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(
          new URL(`${webPaths.auth}${webAuthRoutes.eventsTicket}`, this.origin),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Origin: this.origin,
              [webHeaders.web]: "1",
              [webHeaders.tab]: this.tabId,
            },
            body: JSON.stringify({ tabId: this.tabId }),
          },
        );
      } catch {
        throw offlineError();
      }
      const body = await readJson(response);
      if (!response.ok) throw apiError(response.status, body);
      return parseTicketResponse(apiValue(response.status, body));
    };
    const session = this.options.session();
    if (!session) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
    const token = await session.currentToken();
    try {
      return await send(token);
    } catch (error) {
      if (statusOf(error) !== 401) throw error;
      return send(await session.renewed(token));
    }
  }

  /** Opens the event stream (signed in); no-op while it runs. */
  start() {
    this.stream.start();
  }

  /** Closes the event stream and forgets what it knew (signed out). */
  stop() {
    this.stream.stop();
    this.loaded = false;
    this.loadedSeq = undefined;
    this.pushed = undefined;
  }

  get connected() {
    return this.stream.connected;
  }

  /** Listens to the cloud's events (`resync` asks for a new snapshot). */
  onEvent(listener: (event: AppEvent) => void) {
    return this.hub.subscribe(listener);
  }

  /**
   * A JSON request to the service with the account's token (its GitHub
   * connection, as a web page asks it: shared/web-client/github.ts).
   */
  json(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.transport.json(path, init);
  }

  /** One bridge call on the user's runner. */
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    return this.transport.call(method, await encodeCall(args, this.transport));
  }

  /**
   * The cloud's state: the one the stream pushed after a long disconnection,
   * else a fresh read.
   */
  async snapshot(): Promise<CloudSnapshot> {
    const pushed = this.pushed;
    this.pushed = undefined;
    if (pushed) {
      this.loaded = true;
      return { snapshot: pushed };
    }
    const meta: { eventSeq?: number } = {};
    const snapshot = (await this.transport.call(
      "snapshot",
      await encodeCall([], this.transport),
      meta,
    )) as Snapshot;
    this.loaded = true;
    this.loadedSeq = meta.eventSeq;
    return { snapshot, eventSeq: meta.eventSeq };
  }
}
