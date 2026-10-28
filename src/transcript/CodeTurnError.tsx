import { WarningIcon } from "../policy/GlobalLimitToast";
import { t } from "../i18n";
import { ReasonTooltip } from "../ui/Tooltip";
import {
  isStorageFullError,
  storageFullMessage,
} from "../../shared/turn-errors";
import type { ReplyBannerButton } from "./ReplyBanner";
import type { SetupFailure } from "../../shared/session-setup";

/** A Code turn's failure in the original's words: what failed, and what to do. */
export interface CodeFailure {
  headline: string;
  /** Said while Try again is offered. */
  hint: string;
  /** Said when it is not (an earlier turn's failure). */
  hintWithoutRetry: string;
}

const failures = {
  overloaded: {
    headline: "Service is busy",
    hint: "Try again in a moment, or switch to a different model.",
    hintWithoutRetry:
      "You can send a message to try again in a moment, or switch to a different model.",
  },
  serverError: {
    headline: "Server error",
    hint: "The server returned an error while handling this message. It’s usually temporary.",
    hintWithoutRetry:
      "The server returned an error while handling this message. It’s usually temporary.",
  },
  serverRateLimit: {
    headline: "Server is temporarily limiting requests",
    hint: "Too many requests right now. Try again in a moment.",
    hintWithoutRetry:
      "Too many requests right now. Wait a moment, then send a message to try again.",
  },
  streamIdle: {
    headline: "The response stopped arriving",
    hint: "The response stopped before finishing. Try again in a moment.",
    hintWithoutRetry:
      "The response stopped before finishing. Wait a moment, then send a message to try again.",
  },
  network: {
    headline: "Connection lost",
    hint: "Check your internet connection, VPN, or proxy and try again.",
    hintWithoutRetry:
      "Check your internet connection, VPN, or proxy, then send a message to try again.",
  },
  auth: {
    headline: "Authentication failed",
    hint: "Sign in again to continue.",
    hintWithoutRetry: "Sign in again to continue.",
  },
  generic: {
    headline: "Something went wrong",
    hint: "Try sending your message again.",
    hintWithoutRetry: "Try sending your message again.",
  },
} satisfies Record<string, CodeFailure>;

const setupFailures = {
  upstream: {
    headline: "Unable to connect to repository",
    hint: "Claudex couldn’t reach GitHub to fetch your repository. Try again in a moment.",
    hintWithoutRetry:
      "Claudex couldn’t reach GitHub to fetch your repository. Try again in a moment.",
  },
  failed: {
    headline: "Session couldn’t start",
    hint: "Start a new session to keep working.",
    hintWithoutRetry: "Start a new session to keep working.",
  },
} satisfies Record<SetupFailure, CodeFailure>;

/**
 * A cloud session whose start failed. A message sent next fetches the
 * repository again (Conversation.pendingSetup), so the hint's "Try again" is
 * that.
 */
export function setupFailure(kind: SetupFailure): CodeFailure {
  return setupFailures[kind];
}

/**
 * A failed Code turn's headline and hint, from the engine's error text. The
 * service's status page the original names in some hints is Anthropic's; those
 * hints are used in their form without it. An error of no known kind is
 * "Something went wrong" and a stalled stream "The response stopped arriving".
 */
export function codeFailure(
  error: string | undefined,
  canRewind = false,
): CodeFailure {
  if (isStorageFullError(error))
    return {
      headline: "File storage full",
      hint: storageFullMessage,
      hintWithoutRetry: storageFullMessage,
    };
  const text = (error ?? "").toLowerCase();
  // Image-size failures have recovery hints.
  if (
    /exceeds the dimension limit|image[^\n]*(?:too large|exceeds.*(?:size|dimension))/.test(
      text,
    )
  ) {
    const hint = canRewind
      ? "This image is too large to send. Rewind to remove it and try again."
      : "This image is too large to send. Start a new session to continue.";
    return {
      headline: "Claudex couldn’t process that message",
      hint,
      hintWithoutRetry: hint,
    };
  }
  if (/\b529\b|overloaded/.test(text)) return failures.overloaded;
  if (/\b429\b|rate.?limit|too many requests/.test(text))
    return failures.serverRateLimit;
  if (
    /\b(500|502|503|504)\b|upstream|bad gateway|internal server error/.test(
      text,
    )
  )
    return failures.serverError;
  if (
    /stream (?:disconnected|closed|ended)|incomplete|idle timeout|stopped before/.test(
      text,
    )
  )
    return failures.streamIdle;
  if (
    /timed? ?out|timeout|deadline|econn|enotfound|network|fetch failed|socket|offline|unreachable/.test(
      text,
    )
  )
    return failures.network;
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|sign in/.test(text)
  )
    return failures.auth;
  return failures.generic;
}

/**
 * A failed Code turn: an outlined card at least 480px wide, a header strip on
 * the faint fill with the warning glyph and the headline, the hint under it in
 * the secondary ink, and the actions at its foot, on the right. The original's
 * "View details" (the engine's raw error) is left out: the transcript never
 * shows the engine's own text (src/reply-failure.ts).
 */
export function CodeTurnError({
  failure,
  buttons,
  disabledReason,
}: {
  failure: CodeFailure;
  buttons: ReplyBannerButton[];
  /** Set while the buttons cannot be used; shown as their tooltip. */
  disabledReason?: string;
}) {
  return (
    <div className="code-turn-error" role="alert">
      <div className="code-turn-error-head">
        <WarningIcon />
        <span>{t(failure.headline)}</span>
      </div>
      <div className="code-turn-error-body">
        {t(buttons.length ? failure.hint : failure.hintWithoutRetry)}
      </div>
      {buttons.length > 0 && (
        <div className="code-turn-error-foot">
          {buttons.map((button) => (
            <ReasonTooltip
              key={button.label}
              reason={disabledReason}
              placement="above"
            >
              {(tooltip) => (
                <button
                  {...tooltip}
                  type="button"
                  className={button.primary ? "primary" : "secondary"}
                  aria-disabled={disabledReason ? true : undefined}
                  data-disabled={disabledReason ? true : undefined}
                  onClick={() => {
                    if (!disabledReason) button.onClick();
                  }}
                >
                  {button.label}
                </button>
              )}
            </ReasonTooltip>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The card from the turn's own failure, so TurnOutcome can load this module
 * only when a Code turn has failed: a cloud setup failure, or the turn's
 * error.
 */
export function CodeTurnErrorFor({
  failure,
  setup,
  error,
  canRewind,
  ...rest
}: {
  /** A failure already put in words (an interrupted session). */
  failure?: CodeFailure;
  setup?: SetupFailure;
  error?: string;
  canRewind?: boolean;
} & Omit<Parameters<typeof CodeTurnError>[0], "failure">) {
  return (
    <CodeTurnError
      failure={
        failure ?? (setup ? setupFailure(setup) : codeFailure(error, canRewind))
      }
      {...rest}
    />
  );
}
