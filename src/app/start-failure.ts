import { formatText, t } from "../i18n";

export type StartFailureCategory = "network_error" | "api_server_error";

/**
 * Why a new cloud session failed to start, when it is worth sending the
 * prompt again: the connection dropped, or the service answered with a
 * server error. Anything else keeps its own message.
 */
export function startFailureCategory(
  error: unknown,
): StartFailureCategory | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /Failed to fetch|NetworkError|network (?:error|request failed)|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|net::ERR_/i.test(
      message,
    )
  )
    return "network_error";
  if (
    /\b50[0-4]\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(
      message,
    )
  )
    return "api_server_error";
  return undefined;
}

/**
 * "Your new session couldn’t start. Check your connection, then send your
 * prompt again.": the prompt stays in the composer to send again.
 */
export function startFailureMessage(category: StartFailureCategory) {
  return formatText("{sentence} {hint}", {
    sentence: t("Your new session couldn’t start."),
    hint: t(
      category === "network_error"
        ? "Check your connection, then send your prompt again."
        : "Send your prompt again in a moment.",
    ),
  });
}
