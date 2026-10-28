/**
 * The web version's wire contract:
 *
 * 1. browser ⇄ Go: HTTPS RPC (`rpc/<method>`), the web sign-in endpoints and
 *    one events WebSocket per tab (one-time ticket in Sec-WebSocket-Protocol,
 *    seq numbers for resume);
 * 2. Go ⇄ claudex-runner: the runner link, one WebSocket the runner dials;
 * 3. the stored turn document (schema v1) the runner writes to webstore.
 *
 * The Go mirror is backend/backend/internal/claudex/webproto; both sides read
 * the JSON samples in its testdata/ (tests/web-protocol.test.ts and
 * webproto's Go tests), so a change here needs the same change there.
 *
 * This file runs in the browser, the runner and tests: no Node or DOM APIs.
 */
import type { AppEvent, Snapshot } from "./types";
import { encodeWireValue, decodeWireValue } from "./web-wire";
import { fail } from "./web-wire";

export const webProtocolVersion = 1;

// ---------------------------------------------------------------------------
// Paths, headers, names

const base = "/api/v1/claudex/web";

export const webPaths = {
  base,
  /** POST `${rpc}<method>` with a WebRpcRequest body. */
  rpc: `${base}/rpc/`,
  /** The per-tab events WebSocket. */
  events: `${base}/events`,
  /** Chunked uploads (attachments over the RPC body limit, skills, files). */
  uploads: `${base}/uploads`,
  /** GET `${preview}<id>?k=<signature>`: an artifact preview document. */
  preview: `${base}/preview/`,
  /** Web sign-in session; see webAuthRoutes. */
  auth: `${base}/auth/`,
  /** Downloads Go builds from webstore (exports, generated files). */
  downloads: `${base}/downloads/`,
  /** The runner link WebSocket the runner dials (runner token). */
  runnerLink: `${base}/runner/link`,
} as const;

/** Endpoints under webPaths.auth (all POST; refresh/logout use the cookie). */
export const webAuthRoutes = {
  login: "login",
  twoFactor: "2fa",
  cancelTwoFactor: "2fa/cancel",
  register: "register",
  sendCode: "send-code",
  forgotPassword: "forgot-password",
  resetPassword: "reset-password",
  refresh: "refresh",
  logout: "logout",
  revokeAll: "revoke-all",
  eventsTicket: "events-ticket",
  /** The dictation socket's one-time ticket. */
  voiceTicket: "voice-ticket",
  /** Sign in with a one-time code sent by email (LOGIN). */
  emailCodeSend: "email-code/send",
  emailCodeLogin: "email-code/login",
  /** Sign in with a Google ID token (LOGIN-GOOGLE). */
  googleLogin: "google/login",
  /** Upstream passkey login (begin answers the WebAuthn options). */
  passkeyBegin: "passkey/login/begin",
  passkeyFinish: "passkey/login/finish",
  /** The accounts this browser is signed in to (its account cookies). */
  accounts: "accounts",
} as const;

/** The Go endpoint behind each "remote-go" bridge call. */
export const webGoMethodRoutes = {
  authStatus: webAuthRoutes.refresh,
  registerAccount: webAuthRoutes.register,
  loginAccount: webAuthRoutes.login,
  logoutAccount: webAuthRoutes.logout,
  completeTwoFactor: webAuthRoutes.twoFactor,
  cancelTwoFactor: webAuthRoutes.cancelTwoFactor,
  sendVerificationCode: webAuthRoutes.sendCode,
  revokeAllSessions: webAuthRoutes.revokeAll,
  requestPasswordReset: webAuthRoutes.forgotPassword,
  resetPassword: webAuthRoutes.resetPassword,
  sendSignInCode: webAuthRoutes.emailCodeSend,
  loginWithCode: webAuthRoutes.emailCodeLogin,
  loginWithPasskey: webAuthRoutes.passkeyFinish,
  loginWithGoogle: webAuthRoutes.googleLogin,
  // Several accounts per browser: the list reads the account cookies, a
  // switch refreshes the chosen account's, removing one logs it out.
  browserAccounts: webAuthRoutes.accounts,
  switchAccount: webAuthRoutes.refresh,
  forgetBrowserAccount: webAuthRoutes.logout,
} as const;

export const webHeaders = {
  /** "1" on cookie endpoints (forces a CORS preflight; CSRF guard). */
  web: "X-Claudex-Web",
  /** The tab's random id (events fan-out, presence, ticket binding). */
  tab: "X-Claudex-Web-Tab",
  /** "web" on every request of the web version. */
  client: "X-Claudex-Client",
  /** On the snapshot's answer: the last event number it already holds. */
  eventSeq: "X-Claudex-Event-Seq",
} as const;

export const webClientName = "web";
/**
 * HttpOnly refresh cookie, Path limited to webPaths.auth. Each signed-in
 * account has its own, named `${webRefreshCookie}_<user id>`; the bare name is
 * read for a browser signed in before several accounts were possible.
 */
export const webRefreshCookie = "__Secure-claudex_web_rt";
/** Sub-protocol the events socket selects; the ticket rides beside it. */
export const webEventsSubprotocol = "claudex.v1";
export const webTicketSubprotocolPrefix = "ticket.";
/** Sub-protocol of the runner link. */
export const runnerLinkSubprotocol = "claudex.runner.v1";

export const webLimits = {
  /** Largest RPC request body; bigger attachments go through uploads. */
  rpcBodyBytes: 1024 * 1024,
  uploadChunkBytes: 1024 * 1024,
  /** Largest single runner-link frame. */
  linkFrameBytes: 16 * 1024 * 1024,
  /** Largest stored turn document (bigger tool output is truncated). */
  turnDocBytes: 4 * 1024 * 1024,
  ticketTtlMs: 30_000,
  previewSignatureTtlMs: 5 * 60_000,
  /** Browser and runner pings (Cloudflare drops idle sockets at 100 s). */
  heartbeatMs: 25_000,
  /** Events Go keeps per user for resume. */
  eventRing: 2000,
  /** Per-conversation event coalescing on the runner. */
  coalesceMs: 80,
  /** Default deadline of a relayed call. */
  callTimeoutMs: 120_000,
  methodNameLength: 64,
  runnerMethods: 1000,
  /** Accounts one browser can be signed in to at once (one cookie each). */
  browserAccounts: 5,
} as const;

/** Close codes of the events socket and the runner link. */
export const webCloseCodes = {
  normal: 1000,
  goingAway: 1001,
  /** Ticket missing, expired, reused or bound to another tab. */
  badTicket: 4001,
  /** The web version is off or the account is not on the allow-list. */
  forbidden: 4003,
  /** Signed out (revoke-all, logout, password change). */
  signedOut: 4008,
  /** A frame broke the protocol. */
  protocolError: 4400,
  /** No runner or no capacity; retry later. */
  unavailable: 4503,
  /** Runner link: the runner token is invalid or revoked. */
  runnerRejected: 4401,
  /** Runner link: another link took over this runner id. */
  replaced: 4409,
} as const;

/** Structured error codes the web layer adds (bridge errors carry `code`). */
export const webErrorCodes = {
  disabled: "CLAUDEX_WEB_DISABLED",
  notAllowed: "CLAUDEX_WEB_NOT_ALLOWED",
  capacity: "CLAUDEX_WEB_CAPACITY",
  methodUnavailable: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
  badRequest: "CLAUDEX_WEB_BAD_REQUEST",
  tooLarge: "CLAUDEX_WEB_TOO_LARGE",
  runnerUnavailable: "CLAUDEX_WEB_RUNNER_UNAVAILABLE",
  timeout: "CLAUDEX_WEB_TIMEOUT",
  badTicket: "CLAUDEX_WEB_BAD_TICKET",
  quotaExceeded: "CLAUDEX_WEB_QUOTA_EXCEEDED",
  handlerFailed: "CLAUDEX_WEB_HANDLER_FAILED",
} as const;

const methodPattern = /^[a-z][A-Za-z0-9]{0,63}$/;

/** Bridge method names as they appear in `rpc/<method>` and link calls. */
export function isWebMethodName(name: unknown): name is string {
  return typeof name === "string" && methodPattern.test(name);
}

export type Json = Record<string, unknown>;
export function object(value: unknown, what: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Json;
}
export function string(
  value: unknown,
  what: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value === ""))
    fail(`${what} must be a${allowEmpty ? "" : " non-empty"} string`);
  return value;
}
export function integer(value: unknown, what: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    fail(`${what} must be an integer ≥ ${min}`);
  return value;
}
export function boolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") fail(`${what} must be a boolean`);
  return value;
}
function optional<T>(
  value: unknown,
  read: (value: unknown, what: string) => T,
  what: string,
): T | undefined {
  return value === undefined ? undefined : read(value, what);
}
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (!allowed.includes(value as T))
    fail(`${what} must be one of ${allowed.join(", ")}`);
  return value as T;
}
export function parseJson(text: string | Json): Json {
  if (typeof text !== "string") return object(text, "frame");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("frame is not JSON");
  }
  return object(value, "frame");
}

// ---------------------------------------------------------------------------
// RPC: POST rpc/<method>

export interface WebRpcRequest {
  /** The call's arguments, wire-encoded (encodeWireValue). */
  args: unknown[];
}

export interface WebRpcError {
  /** Plain English, shown as is (like bridgeErrorMessage on the desktop). */
  message: string;
  /** A CLAUDEX_* code. */
  code?: string;
  /** Structured details, e.g. GatewayRefusalDetails. */
  details?: unknown;
}

/**
 * The body of every RPC answer. HTTP 200 carries the handler's outcome (ok or
 * its error); Go's own refusals (401, 403, 413, 429, 503…) use their status
 * with `ok: false`.
 */
export type WebRpcResponse =
  { ok: true; value?: unknown } | { ok: false; error: WebRpcError };

export function rpcRequest(args: unknown[]): WebRpcRequest {
  return { args: args.map(encodeWireValue) as unknown[] };
}

export function parseRpcRequest(body: unknown): WebRpcRequest {
  const json = object(body, "request");
  if (!Array.isArray(json.args)) fail("args must be an array");
  if (Object.keys(json).some((key) => key !== "args"))
    fail("request has unknown fields");
  return { args: json.args.map(decodeWireValue) };
}

export function parseError(value: unknown): WebRpcError {
  const json = object(value, "error");
  const error: WebRpcError = { message: string(json.message, "error.message") };
  if (json.code !== undefined) error.code = string(json.code, "error.code");
  if (json.details !== undefined) error.details = json.details;
  return error;
}

/** The answer's decoded value, or the error to throw (see rpcError). */
export function parseRpcResponse(
  status: number,
  body: unknown,
): { ok: true; value: unknown } | { ok: false; error: WebRpcError } {
  let json: Json;
  try {
    json = object(body, "response");
  } catch {
    return {
      ok: false,
      error: {
        message:
          status === 401
            ? "Your session has expired. Sign in again."
            : `The server answered ${status}.`,
      },
    };
  }
  if (json.ok === false) return { ok: false, error: parseError(json.error) };
  if (json.ok !== true) fail("response has no ok field");
  if (status < 200 || status >= 300)
    return { ok: false, error: { message: `The server answered ${status}.` } };
  return { ok: true, value: decodeWireValue(json.value) };
}

/** An Error for a failed call, with `code` and `details` attached. */
export function rpcError(error: WebRpcError): Error & {
  code?: string;
  details?: unknown;
} {
  return Object.assign(new Error(error.message), {
    ...(error.code ? { code: error.code } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
  });
}

// ---------------------------------------------------------------------------
// Events WebSocket tickets

/** POST auth/events-ticket body and answer. */
export interface WebTicketRequest {
  tabId: string;
}
export interface WebTicketResponse {
  ticket: string;
  /** Seconds until the ticket expires (30). */
  expires_in: number;
}

/** 32 random bytes, base64url without padding. */
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
/** Tab ids: 8-64 of [A-Za-z0-9_-] (the bridge uses a random UUID). */
const tabPattern = /^[A-Za-z0-9_-]{8,64}$/;

export function isWebTicket(value: unknown): value is string {
  return typeof value === "string" && ticketPattern.test(value);
}
export function isWebTabId(value: unknown): value is string {
  return typeof value === "string" && tabPattern.test(value);
}

export function parseTicketResponse(body: unknown): WebTicketResponse {
  const json = object(body, "ticket response");
  const ticket = string(json.ticket, "ticket");
  if (!isWebTicket(ticket)) fail("ticket has the wrong shape");
  return { ticket, expires_in: integer(json.expires_in, "expires_in", 1) };
}

/** The `protocols` argument of `new WebSocket(url, protocols)`. */
export function eventsSubprotocols(ticket: string): string[] {
  if (!isWebTicket(ticket)) fail("ticket has the wrong shape");
  return [webEventsSubprotocol, webTicketSubprotocolPrefix + ticket];
}

/**
 * The ticket in a Sec-WebSocket-Protocol header (comma-separated, possibly
 * repeated); null unless the header offers claudex.v1 and exactly one ticket.
 */
export function ticketFromSubprotocols(header: string | string[]) {
  const offered = (Array.isArray(header) ? header : [header])
    .flatMap((line) => line.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  if (!offered.includes(webEventsSubprotocol)) return null;
  const tickets = offered
    .filter((item) => item.startsWith(webTicketSubprotocolPrefix))
    .map((item) => item.slice(webTicketSubprotocolPrefix.length));
  return tickets.length === 1 && isWebTicket(tickets[0]) ? tickets[0]! : null;
}

// ---------------------------------------------------------------------------
// Events WebSocket frames (browser ⇄ Go)

/** Browser → Go. `hello` first, within the ticket's lifetime. */
export type BrowserFrame =
  | {
      t: "hello";
      v: number;
      tabId: string;
      /** Last seq this tab applied; omit on the first connection. */
      lastSeq?: number;
    }
  | { t: "ping" }
  /** The tab's visibility (drives onWindowFocus and idle reclaim). */
  | { t: "presence"; visible: boolean; focused: boolean };

/** Go → browser. */
export type ServerFrame =
  | {
      t: "ready";
      v: number;
      /** Seq of the last event before this connection's first frame. */
      seq: number;
      /** true when every event after the tab's lastSeq follows. */
      resumed: boolean;
    }
  | { t: "event"; seq: number; event: AppEvent }
  /**
   * lastSeq fell out of the ring (or the runner restarted): the whole state.
   * The bridge replaces its state as after a `snapshot()` call.
   */
  | { t: "snapshot"; seq: number; snapshot: Snapshot }
  /**
   * Open a page the runner could not open itself (payments). `same-tab`
   * navigates the tab; `new-tab` needs a user gesture, so the bridge shows it.
   */
  | { t: "open-url"; url: string; target: "same-tab" | "new-tab" }
  | { t: "pong" }
  /** Sent just before Go closes the socket with a webCloseCodes code. */
  | { t: "error"; code: string; message: string };

export const openTargets = ["same-tab", "new-tab"] as const;

/**
 * Only https: pages (or same-origin paths) may be opened from a frame. A
 * backslash, whitespace or control character is refused outright: browsers
 * turn "/\\evil.example" and "/\t/evil.example" into "//evil.example".
 */
export function isOpenableUrl(url: string) {
  if (/[\\\s\u0000-\u001f\u007f-\u009f]/.test(url)) return false;
  if (url.startsWith("/")) return !url.startsWith("//");
  // "https:///x" has no authority; the URL parser would still find a host.
  if (!url.startsWith("https://") || url.startsWith("https:///")) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

export function parseBrowserFrame(text: string | Json): BrowserFrame {
  const json = parseJson(text);
  switch (json.t) {
    case "hello": {
      const frame: BrowserFrame = {
        t: "hello",
        v: integer(json.v, "v", 1),
        tabId: string(json.tabId, "tabId"),
      };
      if (!isWebTabId(frame.tabId)) fail("tabId has the wrong shape");
      const lastSeq = optional(json.lastSeq, integer, "lastSeq");
      if (lastSeq !== undefined) frame.lastSeq = lastSeq;
      return frame;
    }
    case "ping":
      return { t: "ping" };
    case "presence":
      return {
        t: "presence",
        visible: boolean(json.visible, "visible"),
        focused: boolean(json.focused, "focused"),
      };
    default:
      fail(`unknown browser frame ${JSON.stringify(json.t)}`);
  }
}

export function parseServerFrame(text: string | Json): ServerFrame {
  const json = parseJson(text);
  switch (json.t) {
    case "ready":
      return {
        t: "ready",
        v: integer(json.v, "v", 1),
        seq: integer(json.seq, "seq"),
        resumed: boolean(json.resumed, "resumed"),
      };
    case "event": {
      const event = object(json.event, "event");
      string(event.type, "event.type");
      return {
        t: "event",
        seq: integer(json.seq, "seq", 1),
        event: event as unknown as AppEvent,
      };
    }
    case "snapshot": {
      const snapshot = object(json.snapshot, "snapshot");
      if (!Array.isArray(snapshot.conversations))
        fail("snapshot.conversations must be an array");
      return {
        t: "snapshot",
        seq: integer(json.seq, "seq"),
        snapshot: snapshot as unknown as Snapshot,
      };
    }
    case "open-url": {
      const url = string(json.url, "url");
      if (!isOpenableUrl(url)) fail("url must be https or same-origin");
      return {
        t: "open-url",
        url,
        target: oneOf(json.target, openTargets, "target"),
      };
    }
    case "pong":
      return { t: "pong" };
    case "error":
      return {
        t: "error",
        code: string(json.code, "code"),
        message: string(json.message, "message"),
      };
    default:
      fail(`unknown server frame ${JSON.stringify(json.t)}`);
  }
}

// ---------------------------------------------------------------------------
// Runner link frames (claudex-runner ⇄ Go)

/** The user a relayed call or event belongs to (Sub2API user id). */
export interface LinkUser {
  id: number;
  /** The tab that made the call, when one did. */
  tabId?: string;
  /**
   * The user's current access token, for the runner's calls to Sub2API user
   * APIs (WebRemoteHost). Held in memory only.
   */
  accessToken: string;
}
