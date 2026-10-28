import { turnAuthIssue } from "../../shared/auth-issue";
import {
  isStorageFullError,
  storageFullMessage,
} from "../../shared/turn-errors";

/**
 * A failed reply's reason in one plain sentence. The engine's own text
 * ("unexpected status 502 Bad Gateway: … url: http://127.0.0.1:…") is for logs:
 * the transcript says what happened and what to do, never the address or the
 * JSON. Where the original has a sentence for the cause it is used, with this
 * app's name: overloaded, "Claude is busy right now. Try again in a moment."; a
 * 5xx, "Claude is temporarily unavailable. Try again in a moment."; a lost
 * connection or a stream that stopped early, "Claude couldn’t finish this
 * response. Try again in a moment."; anything else, "This response didn’t
 * load." The rate-limit and sign-in sentences have no counterpart there.
 */
export function failureMessage(error: string | undefined): string {
  if (isStorageFullError(error)) return storageFullMessage;
  const text = (error ?? "").toLowerCase();
  if (/\bpolicy_deny\b/.test(text))
    return "This message was blocked by your organization’s policy.";
  if (
    /\bcontent_filter_blocked\b|the model provider blocked this response/.test(
      text,
    )
  )
    return "This response was blocked by content filtering. Rephrase your message or try again.";
  if (/\b529\b|overloaded/.test(text))
    return "Claudex is busy right now. Try again in a moment.";
  if (
    /\b(502|503|504)\b|upstream|temporarily unavailable|bad gateway/.test(text)
  )
    return "Claudex is temporarily unavailable. Try again in a moment.";
  if (/\b429\b|rate.?limit|too many requests/.test(text))
    return "The service is busy right now. Wait a moment, then try again.";
  if (
    /timed? ?out|timeout|deadline|econn|enotfound|network|fetch failed|socket|offline|unreachable|stream (?:disconnected|closed|ended)|incomplete/.test(
      text,
    )
  )
    return "Claudex couldn’t finish this response. Try again in a moment.";
  // An expired sign-in is said once, by the banner over the composer; the reply
  // itself reads as any other that didn’t load.
  if (turnAuthIssue(error)) return "This response didn’t load.";
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|sign in/.test(text)
  )
    return "The service refused the request. Sign in again, then try again.";
  return "This response didn’t load.";
}
