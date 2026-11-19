/**
 * How a finished turn ended, as far as the transcript needs to know. Codex
 * reports failures as free text, so the length limit is recognised from the
 * gateway's own message and from the Responses API's incomplete reason.
 */
export const lengthLimitMessage =
  "The response reached the model's maximum output length.";

export const toolUseLimitMessage =
  "The response reached its tool-use limit for this turn.";

export function isToolUseLimitError(message: string | undefined) {
  return Boolean(
    message &&
    /tool[ _-]?(?:use[ _-]?)?limit|max(?:imum)?[ _-]tool[ _-](?:calls|uses)/i.test(
      message,
    ),
  );
}

// (live claude.ai bundle, 2026-10-14, shared-m-0-DxR427YZ.js)
export const storageFullMessage =
  "Your disk is full. Free up space and try again.";

export function isStorageFullError(error: unknown): boolean {
  return storageError(error, new Set());
}

function storageError(error: unknown, seen: Set<unknown>): boolean {
  if (typeof error === "string")
    return /\bENOSPC\b|\bEDQUOT\b|no space left on device|disk quota exceeded|your disk is full/i.test(
      error,
    );
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  return (
    value.code === "ENOSPC" ||
    value.code === "EDQUOT" ||
    storageError(value.message, seen) ||
    storageError(value.cause, seen)
  );
}

export function isLengthLimitError(message: string | undefined) {
  return Boolean(
    message &&
    (message.includes(lengthLimitMessage) ||
      /max_output_tokens|max_tokens|maximum output length/i.test(message)),
  );
}

/**
 * Whether a failure says the conversation no longer fits the model's context
 * window (Codex: "ran out of room in the model's context window"; the
 * Responses API: `context_length_exceeded`), so sending it again cannot work.
 */
export function isContextLimitError(message: string | undefined) {
  return Boolean(
    message &&
    /conversation_length_limit|context[ _-]?(window|length)|ran out of room|maximum context|prompt is too long/i.test(
      message,
    ),
  );
}

/**
 * Codex's retryable stream errors carry the attempt in "Reconnecting... 2/5".
 */
export function reconnectAttempt(message: unknown) {
  if (typeof message !== "string") return;
  const match = /^Reconnecting\.\.\. (\d+)\/(\d+)$/.exec(message);
  if (!match) return;
  const attempt = Number(match[1]);
  const maxRetries = Number(match[2]);
  if (Number.isSafeInteger(maxRetries) && attempt >= 1 && attempt <= maxRetries)
    return { attempt, maxRetries };
}

export type RetryCause = "authentication_failed" | "rate_limit" | "overloaded";

export interface StreamRetry {
  attempt: number;
  maxRetries: number;
  cause?: RetryCause;
}

/** The short headline of a retried failure, as both status lines word it. */
export const retryCauseHeadlines = {
  authentication_failed: "Authentication failed",
  rate_limit: "Rate limit reached",
  overloaded: "Server is busy",
} as const satisfies Record<RetryCause, string>;

/**
 * What a retried failure was, as the original names it in "{cause}.
 * Retrying …" (live claude.ai bundle, 2026-10-14, shared-17 ZJ): sign-in,
 * rate limit or a busy server; anything else is "Request failed".
 */
export function retryCause(text: string | undefined): RetryCause | undefined {
  if (!text) return undefined;
  if (/\b401\b|unauthori[sz]ed|authentication|invalid api key/i.test(text))
    return "authentication_failed";
  if (/\b429\b|rate[ _-]?limit|too many requests/i.test(text))
    return "rate_limit";
  if (/\b(?:503|529)\b|overloaded|server is busy|capacity/i.test(text))
    return "overloaded";
  return undefined;
}
