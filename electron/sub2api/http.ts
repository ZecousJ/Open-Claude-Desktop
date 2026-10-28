/**
 * JSON transport for the Claudex (Sub2API) service's user API. Sub2API wraps
 * successes as `{code:0, message, data}` and reports failures either as the
 * envelope `{code:<http>, message, reason, metadata}` or as
 * `{code:"STRING_CODE", message}`; gateway errors may use OpenAI's
 * `{error:{type, code, message}}` and, from a Claudex service, carry a
 * top-level `claudex` object that explains the refusal. Older services
 * answer without `reason`, `metadata` or `claudex`; the code and message are
 * still read from whichever shape arrives.
 *
 * Every request here goes to the Claudex service, so each one carries the
 * `X-Claudex-Version/Platform/Arch` headers; `X-Claudex-Device-Id` only when
 * the caller passes the device id (panel requests that need it).
 */
import { version as packageVersion } from "../../package.json";
import {
  claudexHeaders,
  parseRefusal,
  validClaudexVersion,
  type ClaudexClientInfo,
  type ClaudexRefusal,
} from "../../shared/claudex-contract";

export type Fetch = typeof fetch;

/** An error answer's scalar metadata, e.g. `{limit:"5", active:"5"}` for CLAUDEX_DEVICE_LIMIT. */
export type ErrorMetadata = Record<string, string | number | boolean>;

export class Sub2ApiError extends Error {
  /** The service's explanation of a gateway refusal (401, 402, 403, 426 or 429 only). */
  readonly detail?: ClaudexRefusal;
  /** Seconds to wait before retrying, from `Retry-After` or the refusal. */
  readonly retryAfter?: number;
  /** The envelope's `metadata` (the service sends its values as strings). */
  readonly metadata?: ErrorMetadata;
  constructor(
    readonly status: number,
    /** Sub2API's reason or string code, e.g. INVALID_CREDENTIALS. */
    readonly code: string,
    message: string,
    extra: {
      detail?: ClaudexRefusal;
      retryAfter?: number;
      metadata?: ErrorMetadata;
    } = {},
  ) {
    super(message);
    this.name = "Sub2ApiError";
    if (extra.detail) this.detail = extra.detail;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
    if (extra.metadata) this.metadata = extra.metadata;
  }
}

/** A metadata value as a number, when it is one (`"5"` or `5`). */
export function metadataNumber(
  error: Sub2ApiError,
  key: string,
): number | undefined {
  const value = error.metadata?.[key];
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : undefined;
}

const requestTimeoutMs = 20_000;

/**
 * This build as the service sees it. The version is package.json's, which
 * is what `app.getVersion()` reports; the provider service child receives
 * the same value from its parent in `CLAUDEX_APP_VERSION`.
 */
export function claudexClientInfo(): ClaudexClientInfo {
  const inherited = process.env.CLAUDEX_APP_VERSION;
  return {
    version: validClaudexVersion(inherited) ? inherited : packageVersion,
    platform: process.platform,
    arch: process.arch,
  };
}

/** The error body's code and message, whichever of Sub2API's shapes it uses. */
export function errorFields(body: unknown): { code: string; message: string } {
  if (!body || typeof body !== "object") return { code: "", message: "" };
  const data = body as Record<string, unknown>;
  const nested =
    data.error && typeof data.error === "object"
      ? (data.error as Record<string, unknown>)
      : undefined;
  const code =
    typeof data.reason === "string" && data.reason
      ? data.reason
      : typeof data.code === "string"
        ? data.code
        : typeof nested?.code === "string"
          ? nested.code
          : typeof nested?.type === "string"
            ? nested.type
            : "";
  const message =
    typeof data.message === "string"
      ? data.message
      : typeof nested?.message === "string"
        ? nested.message
        : "";
  return { code, message: message.slice(0, 500) };
}

/** Scalar entries of an envelope's `metadata`; undefined when there are none. */
function errorMetadata(body: unknown): ErrorMetadata | undefined {
  const raw =
    body && typeof body === "object"
      ? (body as { metadata?: unknown }).metadata
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw)
    .filter(
      ([key, value]) =>
        /^[a-z][a-z0-9_.]{0,63}$/i.test(key) &&
        (typeof value === "number"
          ? Number.isFinite(value)
          : typeof value === "boolean" ||
            (typeof value === "string" && value.length <= 500)),
    )
    .slice(0, 20);
  return entries.length
    ? (Object.fromEntries(entries) as ErrorMetadata)
    : undefined;
}

/** `Retry-After` as seconds: a number of seconds or an HTTP date. */
export function retryAfterSeconds(
  header: string | null,
  now = Date.now(),
): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d{1,9}$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? Math.max(0, Math.ceil((at - now) / 1000))
    : undefined;
}

/** A Sub2ApiError for an error answer, with whatever the service explained. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: Pick<Headers, "get">,
): Sub2ApiError {
  const { code, message } = errorFields(body);
  const detail = parseRefusal(status, body);
  const retryAfter =
    retryAfterSeconds(headers?.get("retry-after") ?? null) ??
    detail?.retryAfterSeconds;
  return new Sub2ApiError(
    status,
    code || `HTTP_${status}`,
    message || `The Claudex service returned HTTP ${status}.`,
    { detail, retryAfter, metadata: errorMetadata(body) },
  );
}

export interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  /** This installation's id, for the panel requests that need it; never on the gateway. */
  deviceId?: string;
  /** The ETag of the copy the caller holds; the service may answer 304. */
  ifNoneMatch?: string;
  /** Who is asking (tests); by default this build. */
  client?: ClaudexClientInfo;
}

/** A successful answer, or 304 when the caller's copy is current. */
export type JsonResult =
  | { notModified: true; status: 304; etag?: string }
  | { notModified: false; status: number; data: unknown; etag?: string };

/** A weak or strong ETag as received; anything else is ignored. */
function etagOf(response: Response) {
  const value = response.headers.get("etag");
  return value &&
    value.length <= 200 &&
    /^(W\/)?"[\x21\x23-\x7e]*"$/.test(value)
    ? value
    : undefined;
}

/** Like `requestJson`, with the status, the ETag and 304 answers. */
export async function requestJsonResult(
  fetchImpl: Fetch,
  url: string,
  init: RequestOptions = {},
): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...claudexHeaders(init.client ?? claudexClientInfo(), init.deviceId),
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.ifNoneMatch ? { "If-None-Match": init.ifNoneMatch } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(requestTimeoutMs),
      redirect: "error",
    });
  } catch {
    throw new Sub2ApiError(
      0,
      "UNREACHABLE",
      "The Claudex service is unreachable.",
    );
  }
  const etag = etagOf(response);
  if (response.status === 304 && init.ifNoneMatch) {
    await response.body?.cancel().catch(() => {});
    return { notModified: true, status: 304, ...(etag ? { etag } : {}) };
  }
  const text = (await response.text()).slice(0, 2_000_000);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok)
    throw errorFromResponse(response.status, body, response.headers);
  if (
    body &&
    typeof body === "object" &&
    "code" in body &&
    "data" in (body as Record<string, unknown>)
  ) {
    const envelope = body as {
      code: unknown;
      data: unknown;
      message?: unknown;
    };
    if (envelope.code !== 0) {
      const { code, message } = errorFields(body);
      throw new Sub2ApiError(response.status, code, message, {
        metadata: errorMetadata(body),
      });
    }
    return {
      notModified: false,
      status: response.status,
      data: envelope.data,
      ...(etag ? { etag } : {}),
    };
  }
  return {
    notModified: false,
    status: response.status,
    data: body,
    ...(etag ? { etag } : {}),
  };
}

/** The answer's `data` (or the whole body when it is not an envelope). */
export async function requestJson(
  fetchImpl: Fetch,
  url: string,
  init: Omit<RequestOptions, "ifNoneMatch"> = {},
): Promise<unknown> {
  const result = await requestJsonResult(fetchImpl, url, init);
  return result.notModified ? undefined : result.data;
}
