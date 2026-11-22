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
import { collectOfficialResponse } from "./official-response";

/** Longer than the relay's own deadline, which answers CLAUDEX_WEB_TIMEOUT. */
const clientTimeoutMs = webLimits.callTimeoutMs + 15_000;

type SignedOutReason = Extract<AppEvent, { type: "signed-out" }>["reason"];

/** What the transport needs of the sign-in session (WebAuth, or the desktop's). */
export interface TransportAuth {
  readonly activationIdentity?: object;
  /** The access token; throws "session expired" when there is none. */
  accessToken(): Promise<string>;
  /** A new access token after `stale` was refused; null when the session ended. */
  refresh(stale?: string): Promise<{ accessToken: string } | null>;
  /** Ends the session (the service refused even a new token). */
  expire(reason: SignedOutReason, message?: string): void;
}

export type TransportEnv = Pick<WebEnv, "fetch" | "timers">;
type ResponseMeta = { eventSeq?: number; snapshotTag?: string };
type SnapshotValue = { tag: string; value: unknown };

export class WebTransport {
  private lastSnapshot?: SnapshotValue & { activation: object; body: string };
  private snapshotRead?: {
    activation: object;
    body: string;
    result: Promise<{ value: unknown; eventSeq?: number }>;
  };

  invalidateSnapshotRead() {
    this.snapshotRead = undefined;
  }

  constructor(
    private env: TransportEnv,
    private auth: TransportAuth,
    private tabId: string,
  ) {}

  captureActivation(): () => void {
    const scoped = "activationIdentity" in this.auth;
    const opening = this.auth.activationIdentity;
    if (this.lastSnapshot && this.lastSnapshot.activation !== opening)
      this.lastSnapshot = undefined;
    return () => {
      if (!scoped) return;
      if (opening === undefined) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
      if (this.auth.activationIdentity !== opening)
        throw new DOMException("The active account changed.", "AbortError");
    };
  }

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
  async fetch(
    path: string,
    init: RequestInit = {},
    assertCurrent?: () => void,
  ): Promise<Response> {
    const checkActivation = this.captureActivation();
    const current = () => { checkActivation(); assertCurrent?.(); };
    const send = async (token: string) => {
      current();
      let response: Response;
      try {
        response = await this.env.fetch(path, {
          ...init,
          credentials: "same-origin",
          cache: "no-store",
          headers: this.headers(token, init.headers),
        });
      } catch (error) {
        current();
        if ((error as Error)?.name === "AbortError")
          throw bridgeError(messages.timeout, webErrorCodes.timeout);
        throw offlineError();
      }
      current();
      return response;
    };
    // Throws "session expired" when there is no session to refresh.
    current();
    const token = await this.auth.accessToken();
    const first = await send(token);
    if (first.status !== 401) return first;
    current();
    const next = await this.auth.refresh(token);
    if (!next) {
      if (this.auth.activationIdentity !== undefined) current();
      throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
    }
    const second = await send(next.accessToken);
    if (second.status === 401) {
      current();
      this.auth.expire("session-expired");
      throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
    }
    return second;
  }

  /** GET/POST that answers JSON (the service's own endpoints). */
  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const current = this.captureActivation();
    const writes = !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
    if (writes) this.invalidateSnapshotRead();
    try {
      const response = await this.fetch(path, init, current);
      const body = await readJson(response);
      current();
      if (!response.ok) throw apiError(response.status, body);
      return body;
    } finally {
      if (writes) this.invalidateSnapshotRead();
    }
  }

  keepaliveRpc(method: string, body: string, token: string) {
    this.invalidateSnapshotRead();
    void this.env.fetch(`${webPaths.rpc}${encodeURIComponent(method)}`, {
      method: "POST",
      headers: this.headers(token, { "Content-Type": "application/json" }),
      body,
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
    }).catch(() => {});
  }

  /**
   * One bridge call on the user's runner. `body` is the wire-encoded
   * WebRpcRequest (see codec.ts, which moves large bytes to uploads first).
   */
  async call(
    method: string,
    body: string,
    meta?: { eventSeq?: number },
    assertCallCurrent?: () => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const checkActivation = this.captureActivation();
    const current = () => {
      checkActivation();
      assertCallCurrent?.();
      signal?.throwIfAborted();
    };
    current();
    const owner = this.auth.activationIdentity;
    if (method === "snapshot" && owner && !signal) {
      let pending = this.snapshotRead;
      if (!pending || pending.activation !== owner || pending.body !== body) {
        const responseMeta: ResponseMeta = {};
        const previous = this.lastSnapshot;
        const cached = previous?.activation === owner && previous.body === body
          ? previous
          : undefined;
        const result = this.rpc(method, body, responseMeta, checkActivation, undefined, { cached })
          .then((value) => {
            if (this.snapshotRead?.result === result) {
              this.lastSnapshot = responseMeta.snapshotTag
                ? { activation: owner, body, tag: responseMeta.snapshotTag, value }
                : undefined;
            }
            return { value, eventSeq: responseMeta.eventSeq };
          })
          .finally(() => {
            if (this.snapshotRead?.result === result) this.invalidateSnapshotRead();
          });
        pending = { activation: owner, body, result };
        this.snapshotRead = pending;
      }
      const answer = await pending.result;
      current();
      if (meta) meta.eventSeq = answer.eventSeq;
      return structuredClone(answer.value);
    }
    if (method === "conversationTurns" || method === "snapshot")
      return this.rpc(method, body, meta, current, signal);
    this.invalidateSnapshotRead();
    if (method !== "readProjectKnowledge")
      return this.rpc(method, body, meta, current, signal)
        .finally(() => this.invalidateSnapshotRead());
    const activation = this.auth.activationIdentity;
    if (activation === undefined) return this.rpc(method, body, meta, current, signal);
    const request: unknown = JSON.parse(body);
    if (
      !request ||
      typeof request !== "object" ||
      !("args" in request) ||
      !Array.isArray(request.args) ||
      request.args.length !== 2
    )
      return this.rpc(method, body, meta, current, signal);

    const isCurrent = () => this.auth.activationIdentity === activation;
    const assertCurrent = () => {
      current();
      if (!isCurrent())
        throw new Error("The account changed during this request.");
    };
    const value = await this.rpc(
      method,
      JSON.stringify({
        ...request,
        args: [...request.args, { responseTransfer: true }],
      }),
      meta,
      assertCurrent,
      signal,
    );
    assertCurrent();
    if (!value || typeof value !== "object" || !("status" in value))
      return value;

    const answer = await collectOfficialResponse({
      initial: value,
      allowTransfer: true,
      isCurrent,
      readChunk: (path) =>
        this.rpc(
          "officialUiRead",
          JSON.stringify({ args: [{ method: "GET", path }] }),
          undefined,
          assertCurrent,
          signal,
        ),
    });
    if (answer.status !== 200 || answer.contentType !== "application/json")
      throw new Error("The project knowledge response was not valid.");
    const bytes = new Uint8Array(answer.body);
    const content =
      answer.bodyEncoding === "gzip"
        ? new Blob([bytes])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"))
        : bytes;
    const preview: unknown = await new Response(content).json();
    assertCurrent();
    return preview;
  }

  private async rpc(
    method: string,
    body: string,
    meta?: ResponseMeta,
    assertCurrent?: () => void,
    signal?: AbortSignal,
    snapshot?: { cached?: SnapshotValue },
  ): Promise<unknown> {
    if (new TextEncoder().encode(body).byteLength > webLimits.rpcBodyBytes)
      throw bridgeError(messages.tooLarge, webErrorCodes.tooLarge);
    const abort = new AbortController();
    const timer = this.env.timers.setTimeout(
      () => abort.abort(),
      clientTimeoutMs,
    );
    try {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (snapshot) headers.set(webHeaders.snapshotTag, snapshot.cached?.tag ?? "new");
      const response = await this.fetch(
        `${webPaths.rpc}${encodeURIComponent(method)}`,
        {
          method: "POST",
          headers,
          body,
          signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
        },
        assertCurrent,
      );
      assertCurrent?.();
      const tag = response.headers.get(webHeaders.snapshotTag);
      if (snapshot && meta && tag && /^[0-9a-f]{64}$/.test(tag))
        meta.snapshotTag = tag;
      const seq = response.headers.get(webHeaders.eventSeq);
      if (meta && seq !== null && /^\d+$/.test(seq))
        meta.eventSeq = Number(seq);
      if (response.status === 204 && snapshot?.cached && tag === snapshot.cached.tag)
        return snapshot.cached.value;
      const json = await readJson(response);
      assertCurrent?.();
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
