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
 * Codex reports a dropped stream it is about to retry as an error with
 * willRetry set, e.g. "Reconnecting... 2/5". Returns the attempt text shown
 * under the reply, or undefined when there is nothing to show.
 */
export function reconnectAttempt(message: string | undefined) {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(message ?? "");
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export type RetryCause = "authentication_failed" | "rate_limit" | "overloaded";

/** The short headline of a retried failure, as both status lines word it. */
export const retryCauseHeadlines = {
  authentication_failed: "Authentication failed",
  rate_limit: "Rate limit reached",
  overloaded: "Server is busy",
} as const satisfies Record<RetryCause, string>;

/**
 * What a retried failure was, as the original names it in "{cause}. Retrying
 * …": sign-in, rate limit or a busy server; anything else is "Request failed".
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
