/**
 * Errors the web bridge throws. Like the desktop preload, a failed call
 * rejects with an Error whose message is a plain English sentence the window
 * shows as is; `code` and `details` carry the structured refusal when the
 * service sent one (shared/web-protocol.ts `rpcError`).
 */
import { rpcError, webErrorCodes } from "../web-protocol";

export type BridgeError = Error & {
  code?: string;
  details?: unknown;
  /** The HTTP status of a refused request (not sent to the window). */
  status?: number;
};

export function bridgeError(
  message: string,
  code?: string,
  details?: unknown,
): BridgeError {
  return rpcError({
    message,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

export const messages = {
  offline: "Can't reach Claudex. Check your connection and try again.",
  sessionExpired: "Your session has expired. Sign in again.",
  timeout: "Claudex took too long to answer. Try again.",
  tooLarge: "This is too large to send.",
} as const;

export function offlineError() {
  return bridgeError(messages.offline, webErrorCodes.runnerUnavailable);
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * The error in a failed answer, whichever shape it uses: the web protocol's
 * `{ok:false, error:{message, code, details}}`, Sub2API's envelope
 * `{code:<status>, message, reason}`, `{code:"STRING", message}`, or
 * OpenAI's `{error:{code|type, message}}`.
 */
export function apiError(status: number, body: unknown): BridgeError {
  const json = record(body);
  const nested = record(json?.error);
  const message =
    text(nested?.message) ??
    text(json?.message) ??
    (status === 401
      ? messages.sessionExpired
      : status === 429
        ? "Too many requests. Wait a moment and try again."
        : status === 0
          ? messages.offline
          : `The server answered ${status}.`);
  const code =
    text(nested?.code) ??
    text(json?.reason) ??
    (typeof json?.code === "string" ? text(json.code) : undefined) ??
    text(nested?.type);
  const error = bridgeError(
    message.slice(0, 500),
    code,
    nested?.details ?? json?.metadata,
  );
  if (status) Object.defineProperty(error, "status", { value: status });
  return error;
}

/** The HTTP status a request was refused with, if any. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as BridgeError | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * The value of a successful answer: the web protocol's `{ok:true, value}`,
 * Sub2API's `{code:0, data}`, or the body itself. An envelope that reports
 * a failure is thrown as its error.
 */
export function apiValue(status: number, body: unknown): unknown {
  const json = record(body);
  if (json?.ok === true) return json.value;
  if (json?.ok === false) throw apiError(status, body);
  if (typeof json?.code === "number" && "data" in json) {
    if (json.code !== 0) throw apiError(status, body);
    return json.data;
  }
  return body;
}

/** The body of a response as JSON, or undefined when it is not JSON. */
export async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text().catch(() => "");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
