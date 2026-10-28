/**
 * Authorized requests to the Claudex service and the RPC call that stands in
 * for the desktop's `ipcRenderer.invoke` (W-ARCH §3.1): `POST
 * /api/v1/claudex/web/rpc/<method>` with `{args}`, the in-memory access
 * token as a Bearer token and the tab's id. A 401 refreshes the token once
 * and repeats the request; a second 401 ends the session, and the window
 * returns to the sign-in screen through a `signed-out` event.
 *
 * The desktop app's cloud client (electron/cloud) runs this same transport
 * in its main process with its own account session.
 */
import {
  parseRpcResponse,
  rpcError,
  webClientName,
  webErrorCodes,
  webHeaders,
  webLimits,
  webPaths,
} from "../web-protocol";
import { WebProtocolError } from "../web-wire";
import type { AppEvent } from "../types";
import type { WebEnv } from "./env";
import {
  apiError,
  bridgeError,
  messages,
  offlineError,
  readJson,
} from "./errors";

/** Longer than the relay's own deadline, which answers CLAUDEX_WEB_TIMEOUT. */
const clientTimeoutMs = webLimits.callTimeoutMs + 15_000;

type SignedOutReason = Extract<AppEvent, { type: "signed-out" }>["reason"];

/** What the transport needs of the sign-in session (WebAuth, or the desktop's). */
export interface TransportAuth {
  /** The access token; throws "session expired" when there is none. */
  accessToken(): Promise<string>;
  /** A new access token after `stale` was refused; null when the session ended. */
  refresh(stale?: string): Promise<{ accessToken: string } | null>;
  /** Ends the session (the service refused even a new token). */
  expire(reason: SignedOutReason, message?: string): void;
}

export type TransportEnv = Pick<WebEnv, "fetch" | "timers">;

export class WebTransport {
  constructor(
    private env: TransportEnv,
    private auth: TransportAuth,
    private tabId: string,
  ) {}

  private headers(token: string, extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set(webHeaders.tab, this.tabId);
    headers.set(webHeaders.client, webClientName);
    return headers;
  }

  /**
   * A request with the access token. Refreshes and repeats it once on 401;
   * ends the session when the service still refuses the new token.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string) => {
      try {
        return await this.env.fetch(path, {
          ...init,
          credentials: "same-origin",
          cache: "no-store",
          headers: this.headers(token, init.headers),
        });
      } catch (error) {
        if ((error as Error)?.name === "AbortError")
          throw bridgeError(messages.timeout, webErrorCodes.timeout);
        throw offlineError();
      }
    };
    // Throws "session expired" when there is no session to refresh.
    const token = await this.auth.accessToken();
    const first = await send(token);
    if (first.status !== 401) return first;
    const next = await this.auth.refresh(token);
    if (!next) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
    const second = await send(next.accessToken);
    if (second.status === 401) {
      this.auth.expire("session-expired");
      throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
    }
    return second;
  }

  /** GET/POST that answers JSON (the service's own endpoints). */
  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(path, init);
    const body = await readJson(response);
    if (!response.ok) throw apiError(response.status, body);
    return body;
  }

  /**
   * One bridge call on the user's runner. `body` is the wire-encoded
   * WebRpcRequest (see codec.ts, which moves large bytes to uploads first).
   */
  async call(
    method: string,
    body: string,
    meta?: { eventSeq?: number },
  ): Promise<unknown> {
    if (new TextEncoder().encode(body).byteLength > webLimits.rpcBodyBytes)
      throw bridgeError(messages.tooLarge, webErrorCodes.tooLarge);
    const abort = new AbortController();
    const timer = this.env.timers.setTimeout(
      () => abort.abort(),
      clientTimeoutMs,
    );
    try {
      const response = await this.fetch(
        `${webPaths.rpc}${encodeURIComponent(method)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: abort.signal,
        },
      );
      const json = await readJson(response);
      const seq = response.headers.get(webHeaders.eventSeq);
      if (meta && seq !== null && /^\d+$/.test(seq))
        meta.eventSeq = Number(seq);
      let outcome;
      try {
        outcome = parseRpcResponse(response.status, json);
      } catch (error) {
        if (error instanceof WebProtocolError)
          throw bridgeError(`The server answered ${response.status}.`);
        throw error;
      }
      if (outcome.ok) return outcome.value;
      const failure = rpcError(outcome.error);
      Object.defineProperty(failure, "status", { value: response.status });
      throw failure;
    } finally {
      this.env.timers.clearTimeout(timer);
    }
  }
}
