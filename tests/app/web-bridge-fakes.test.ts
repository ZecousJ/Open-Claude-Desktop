/**
 * Fakes of the page for the web bridge tests (src-web/bridge/env.ts): a
 * scripted fetch, sockets the test opens and closes, a manual clock, and
 * broadcast channels and a lock shared by several fake tabs. The file holds
 * no tests of its own; the other tests/web-bridge-*.test.ts files import it.
 */
import type { AppEvent } from "../../shared/types";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { createWebBridge } from "../../src-web/bridge";
import type {
  ChannelLike,
  PickedFile,
  SocketLike,
  WebEnv,
} from "../../shared/web-client/env";

export const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

export class FakeClock {
  now = Date.UTC(2026, 8, 26, 12);
  private next = 1;
  private timers = new Map<
    number,
    { at: number; callback: () => void; every?: number }
  >();

  setTimeout = (callback: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + Math.max(0, ms), callback });
    return id;
  };
  setInterval = (callback: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, callback, every: ms });
    return id;
  };
  clear = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  pending() {
    return [...this.timers.values()].map((timer) => timer.at - this.now);
  }

  /** Moves the clock, running every timer that falls due, in order. */
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.now = Math.max(this.now, timer.at);
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  protocol = "";
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  closedWith?: { code?: number; reason?: string };
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(
      typeof data === "string"
        ? data
        : new Uint8Array(
            ArrayBuffer.isView(data)
              ? data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength,
                )
              : data,
          ),
    );
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  /** The server accepts the upgrade. */
  open(protocol = "claudex.v1") {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({
      data: typeof frame === "string" ? frame : JSON.stringify(frame),
    });
  }
  /** The server (or the network) closes the socket. */
  drop(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  frames() {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item));
  }
}

/** Channels and a lock shared by the fake tabs of one browser. */
export class FakeBrowser {
  private channels = new Map<string, Set<ChannelLike>>();
  private locks = new Map<string, Promise<unknown>>();
  cookie = "rt-1";
  /** localStorage, shared by the browser's tabs. */
  local = new Map<string, string>();

  channel(name: string): ChannelLike {
    const members = this.channels.get(name) ?? new Set();
    this.channels.set(name, members);
    const channel: ChannelLike = {
      onmessage: null,
      postMessage: (message) => {
        const copy = structuredClone(message);
        for (const other of members)
          if (other !== channel)
            queueMicrotask(() => other.onmessage?.({ data: copy }));
      },
      close: () => members.delete(channel),
    };
    members.add(channel);
    return channel;
  }

  withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
    const before = this.locks.get(name) ?? Promise.resolve();
    const run = before.then(task, task);
    this.locks.set(
      name,
      run.catch(() => {}),
    );
    return run;
  }
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
  credentials?: RequestCredentials;
}

export type Route = (
  request: RecordedRequest,
) => Response | undefined | Promise<Response | undefined>;

export const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export interface FakeTab {
  env: WebEnv;
  clock: FakeClock;
  requests: RecordedRequest[];
  sockets: FakeSocket[];
  downloads: Array<{ name: string; data: Blob }>;
  tabs: string[];
  navigated: string[];
  clipboard: string[];
  routes: Route[];
  files: PickedFile[];
  picks: Array<{ accept: string; multiple: boolean }>;
  visibility: Array<(visible: boolean, focused: boolean) => void>;
  online: Array<() => void>;
  session: Map<string, string>;
  permission: "granted" | "denied" | "prompt";
}

let ids = 0;

export function fakeTab(
  browser = new FakeBrowser(),
  clock = new FakeClock(),
): FakeTab {
  const tab: FakeTab = {
    clock,
    requests: [],
    sockets: [],
    downloads: [],
    tabs: [],
    navigated: [],
    clipboard: [],
    routes: [],
    files: [],
    picks: [],
    visibility: [],
    online: [],
    session: new Map(),
    permission: "prompt",
    env: undefined as unknown as WebEnv,
  };
  tab.env = {
    origin: "https://claudex.example",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const raw = init.body;
      let body: unknown = raw;
      if (typeof raw === "string") {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const request: RecordedRequest = {
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body,
        credentials: init.credentials,
      };
      tab.requests.push(request);
      for (const route of tab.routes) {
        const response = await route(request);
        if (response) return response;
      }
      return json({ code: 404, message: `No route for ${url}` }, 404);
    },
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      tab.sockets.push(socket);
      return socket;
    },
    channel: (name) => browser.channel(name),
    withLock: (name, task) => browser.withLock(name, task),
    timers: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clear,
      setInterval: clock.setInterval,
      clearInterval: clock.clear,
    },
    now: () => clock.now,
    randomId: () => `id-${String(++ids).padStart(8, "0")}`,
    download: (name, data) => tab.downloads.push({ name, data }),
    pickFiles: async (options) => {
      tab.picks.push(options);
      return tab.files;
    },
    openTab: async (url) => {
      tab.tabs.push(await url);
    },
    navigate: (url) => tab.navigated.push(url),
    writeClipboard: async (text) => {
      tab.clipboard.push(text);
    },
    writeImageClipboard: async (src) => {
      tab.clipboard.push(src);
    },
    microphonePermission: async () => tab.permission,
    platformHint: "MacIntel",
    onVisibility: (listener) => tab.visibility.push(listener),
    onOnline: (listener) => tab.online.push(listener),
    development: false,
    sessionValue: (key) => tab.session.get(key),
    setSessionValue: (key, value) => {
      if (value === undefined) tab.session.delete(key);
      else tab.session.set(key, value);
    },
    localValue: (key) => browser.local.get(key),
    setLocalValue: (key, value) => {
      if (value === undefined) browser.local.delete(key);
      else browser.local.set(key, value);
    },
  };
  return tab;
}

/**
 * A service that signs in `user` and hands out tickets. The refresh cookie
 * is `browser.cookie`; each refresh rotates it, and a second refresh with
 * the same cookie fails (replay).
 */
export function authService(
  tab: FakeTab,
  browser: FakeBrowser,
  options: { signedIn?: boolean; expiresIn?: number } = {},
) {
  let signedIn = options.signedIn ?? true;
  let tokens = 0;
  let tickets = 0;
  const used = new Set<string>();
  const service = {
    valid: new Set<string>(),
    refreshes: 0,
    signOut() {
      signedIn = false;
      service.valid.clear();
    },
    issue() {
      const token = `at-${++tokens}`;
      service.valid.add(token);
      return token;
    },
  };
  const user = { id: 42, email: "ada@example.com", username: "Ada" };
  tab.routes.push((request) => {
    const path = new URL(request.url, "https://claudex.example").pathname;
    if (path === "/api/v1/claudex/web/auth/refresh") {
      service.refreshes++;
      const cookie = browser.cookie;
      if (!signedIn || used.has(cookie))
        return json(
          {
            code: 401,
            message: "Sign in again",
            reason: "REFRESH_TOKEN_INVALID",
          },
          401,
        );
      used.add(cookie);
      browser.cookie = `rt-${tokens + 2}`;
      return json({
        code: 0,
        message: "success",
        data: {
          access_token: service.issue(),
          expires_in: options.expiresIn ?? 3600,
          user,
        },
      });
    }
    if (
      path === "/api/v1/claudex/web/auth/events-ticket" ||
      path === "/api/v1/claudex/web/auth/voice-ticket"
    ) {
      const token = request.headers.get("authorization")?.slice(7) ?? "";
      if (!service.valid.has(token))
        return json({ code: 401, message: "Unauthorized" }, 401);
      const ticket = `T${String(++tickets).padStart(42, "x")}`;
      return json({ ticket, expires_in: 30 });
    }
    if (path === "/api/v1/settings/public")
      return json({
        code: 0,
        data: {
          site_name: "Claudex",
          registration_enabled: true,
          email_verify_enabled: true,
          backend_mode_enabled: false,
        },
      });
    return undefined;
  });
  return service;
}

/**
 * Answers `rpc/<method>` for valid tokens: `handler` returns the value, or
 * throws to answer the handler's error (`{ok:false, error}`).
 */
export function rpcService(
  tab: FakeTab,
  service: { valid: Set<string> },
  handler: (method: string, args: unknown[]) => unknown,
) {
  const calls: Array<{
    method: string;
    args: unknown[];
    request: RecordedRequest;
  }> = [];
  tab.routes.push(async (request) => {
    const path = new URL(request.url, "https://claudex.example").pathname;
    const prefix = "/api/v1/claudex/web/rpc/";
    if (!path.startsWith(prefix)) return undefined;
    const token = request.headers.get("authorization")?.slice(7) ?? "";
    if (!service.valid.has(token))
      return json({ ok: false, error: { message: "Unauthorized" } }, 401);
    const method = decodeURIComponent(path.slice(prefix.length));
    const args = decodeWireValue(
      (request.body as { args: unknown[] }).args,
    ) as unknown[];
    calls.push({ method, args, request });
    try {
      const value = await handler(method, args);
      return json({ ok: true, value: encodeWireValue(value) });
    } catch (error) {
      const failure = error as Error & { code?: string };
      return json({
        ok: false,
        error: {
          message: failure.message,
          ...(failure.code ? { code: failure.code } : {}),
        },
      });
    }
  });
  return calls;
}

/** A bridge in a fake tab, signed in through the refresh cookie. */
export async function signedInBridge(
  handler: (method: string, args: unknown[]) => unknown = () => null,
  options: { browser?: FakeBrowser; clock?: FakeClock } = {},
) {
  const browser = options.browser ?? new FakeBrowser();
  const tab = fakeTab(browser, options.clock);
  const service = authService(tab, browser);
  const calls = rpcService(tab, service, handler);
  const bridge = createWebBridge(tab.env);
  const events: AppEvent[] = [];
  bridge.api.onEvent((event) => events.push(event));
  const status = await bridge.api.authStatus();
  await flush();
  // The snapshot the bridge asks for as soon as the session is known
  // (src-web/bridge/index.ts); tests count their own calls after it.
  const early = calls.splice(0);
  return { browser, tab, service, calls, early, bridge, events, status };
}
