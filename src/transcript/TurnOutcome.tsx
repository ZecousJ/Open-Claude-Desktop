import type { Mode, Turn } from "../../shared/types";
import { retryCauseHeadlines, type RetryCause } from "../../shared/turn-errors";
import { ReplyBanner, waitingForResponse } from "./ReplyBanner";
import { failureMessage } from "./reply-failure";
import { isContextLimitError } from "../../shared/turn-errors";
import { Suspense } from "react";
import { lazyPiece, preloadPiece } from "../ui/lazy-piece";

// A failed Code turn's card loads with the first one.
const CodeTurnErrorFor = lazyPiece(
  () => import("./CodeTurnError"),
  "CodeTurnErrorFor",
);
const UsageHold = lazyPiece(() => import("./UsageHold"), "UsageHold");
/** For server rendering (tests): have the error card ready. */
export const preloadCodeTurnError = () => preloadPiece(CodeTurnErrorFor);
import { formatText, t } from "../i18n";

/**
 * Whether a reply has anything to show: written text or a step it took. A
 * turn stopped before that (a thought alone is not shown) has an empty reply.
 */
export function replyIsEmpty(turn: Turn) {
  return !turn.items.some((item) =>
    item.type === "agentMessage"
      ? Boolean(item.text?.trim())
      : item.type !== "reasoning",
  );
}

/** The sentence of a failure with no known reason. */
const unexplainedFailure = "This response didn’t load.";

/**
 * A Chat or Cowork reply that failed before writing anything, for no reason
 * the transcript can name: the kind several of which fold into one notice.
 */
function unexplainedEmptyFailure(turn: Turn) {
  return (
    turn.status === "failed" &&
    !turn.sendFailed &&
    turn.stopReason !== "conversation_length_limit" &&
    turn.stopReason !== "length" &&
    turn.stopReason !== "tool_use_limit" &&
    turn.stopReason !== "usage_limit" &&
    !turn.compaction &&
    replyIsEmpty(turn) &&
    failureMessage(turn.error) === unexplainedFailure
  );
}

/**
 * Failed replies shown as one notice: in a run of two or more turns in a row
 * whose replies failed with nothing written and no known reason, only the last
 * says how many did not load; the ones before it show no notice. The map gives
 * the run's length for its last turn and 0 for the others; a turn in no such
 * run is absent.
 */
export function failedRuns(turns: readonly Turn[]): Map<string, number> {
  const runs = new Map<string, number>();
  let run: Turn[] = [];
  const close = () => {
    if (run.length > 1)
      run.forEach((turn, index) =>
        runs.set(turn.id, index === run.length - 1 ? run.length : 0),
      );
    run = [];
  };
  for (const turn of turns) {
    if (unexplainedEmptyFailure(turn)) run.push(turn);
    else close();
  }
  close();
  return runs;
}

/**
 * What the transcript says under a reply that did not finish normally: a
 * reconnect in progress, a stop, the output limit with Continue, a Code
 * session that ran out of room with Hand off to a new session, or a failure
 * with its reason, Try again and Continue. They are banners inside the
 * conversation, as the original has them. Continue and Try again call the
 * send path; Edit prompt reopens the prompt in its editor.
 */
export function TurnOutcome({
  turn,
  mode = "chat",
  latest,
  busy,
  onRetry,
  onContinue,
  onHandOff,
  onNewChat,
  onEditPrompt,
  failedRun,
  effort,
  effortRecommended = false,
  canRewind,
}: {
  turn: Turn;
  mode?: Mode;
  latest: boolean;
  busy: boolean;
  onRetry: () => void;
  onContinue: () => void;
  /** Code: starts a new session from a note about this one. */
  onHandOff?: () => void;
  onNewChat?: () => void;
  /** Puts the turn's prompt into its editor (Chat). */
  onEditPrompt?: () => void;
  /**
   * Chat and Cowork: this turn's place in a run of failed replies
   * (`failedRuns`): 0 when a later notice speaks for it, else how many
   * replies that notice counts.
   */
  failedRun?: number;
  effort?: string;
  effortRecommended?: boolean;
  canRewind?: boolean;
}) {
  // The line is plain grey text; the status line's star is already the activity
  // mark, so no second spinner. Code's status line says it ("Connection lost ·
  // Retrying (2/5)").
  if (turn.status === "inProgress")
    return turn.reconnecting && mode !== "code" ? (
      <p className="turn-reconnecting" role="status">
        {turn.reconnecting === "retrying"
          ? t("Reconnecting…")
          : retryingText(turn.reconnecting, turn.reconnectCause)}
      </p>
    ) : null;
  // A /compact turn has no prompt to send again.
  const retryable = latest && !turn.compaction;
  if (turn.stopReason === "usage_limit")
    return (
      <Suspense fallback={null}>
        <UsageHold
          turn={turn}
          mode={mode}
          latest={latest}
          busy={busy}
          onContinue={onContinue}
          onRetry={onRetry}
        />
      </Suspense>
    );
  if (turn.status === "interrupted") {
    // Code's process_interrupted.
    if (mode === "code")
      return (
        <Suspense fallback={null}>
          <CodeTurnErrorFor
            failure={{
              headline: t("Session was interrupted"),
              hint: "Try sending your message again.",
              hintWithoutRetry: "Try sending your message again.",
            }}
            buttons={
              retryable ? [{ label: "Try again", onClick: onRetry }] : []
            }
            disabledReason={busy ? waitingForResponse : undefined}
          />
        </Suspense>
      );
    if (turn.stopReason === "restart")
      return (
        <p className="turn-interrupted" role="status">
          Claudex closed before this response finished
        </p>
      );
    // After Stop the original keeps the cut-off text and shows no "Interrupted"
    // line. When nothing at all was written the reply would be blank, so the
    // original says so.
    if (mode !== "chat" || !replyIsEmpty(turn)) return null;
    return (
      <ReplyBanner
        mode={mode}
        buttons={
          retryable
            ? [
                ...(onEditPrompt
                  ? [{ label: "Edit prompt", onClick: onEditPrompt }]
                  : []),
                { label: "Try again", onClick: onRetry },
              ]
            : []
        }
        disabledReason={busy ? waitingForResponse : undefined}
      >
        Claudex’s response was interrupted.
      </ReplyBanner>
    );
  }
  if (turn.status !== "failed") return null;
  if (turn.sendFailed) return null;
  if (
    mode === "chat" &&
    (turn.stopReason === "conversation_length_limit" ||
      isContextLimitError(turn.error))
  )
    return (
      <ReplyBanner
        mode={mode}
        role="alert"
        buttons={
          latest && onNewChat
            ? [{ label: "Start a new chat", onClick: onNewChat }]
            : []
        }
        disabledReason={busy ? waitingForResponse : undefined}
      >
        {t("This chat is full. Start a new chat to keep going.")}
      </ReplyBanner>
    );
  // Limit notices.
  if (turn.stopReason === "length" || turn.stopReason === "tool_use_limit")
    return (
      <ReplyBanner
        mode={mode}
        buttons={latest ? [{ label: "Continue", onClick: onContinue }] : []}
        disabledReason={busy ? waitingForResponse : undefined}
      >
        {turn.stopReason === "length"
          ? "Claudex reached its max length for this message."
          : "Claudex reached its tool-use limit for this turn."}
        {turn.stopReason === "length" &&
          effort === "max" &&
          !effortRecommended && (
            <>
              {" "}
              {
                "Max effort uses your limits faster than High. Consider a lower effort setting."
              }
            </>
          )}
      </ReplyBanner>
    );
  // A cloud session that could not start says so in its own words; Try
  // again would skip the repository, so the next message is the retry.
  if (mode === "code" && turn.setup?.failure)
    return (
      <Suspense fallback={null}>
        <CodeTurnErrorFor setup={turn.setup.failure} buttons={[]} />
      </Suspense>
    );
  // The session no longer fits the context window, so Try again and Continue
  // would fail the same way: the way on is a new session.
  if (
    mode === "code" &&
    onHandOff &&
    (turn.stopReason === "conversation_length_limit" ||
      isContextLimitError(turn.error))
  )
    return (
      <ReplyBanner
        mode={mode}
        role="alert"
        buttons={
          latest
            ? [
                {
                  label: "Hand off to a new session",
                  onClick: onHandOff,
                },
              ]
            : []
        }
        disabledReason={busy ? waitingForResponse : undefined}
      >
        This session is full. Start a new session to keep going.
      </ReplyBanner>
    );
  // A Code turn's failure is the Code session's own card: a headline and what
  // to do, not Chat's sentence.
  if (mode === "code")
    return (
      <Suspense fallback={null}>
        <CodeTurnErrorFor
          error={turn.error}
          canRewind={canRewind}
          buttons={
            retryable
              ? [
                  { label: "Try again", onClick: onRetry },
                  { label: "Continue", onClick: onContinue },
                ]
              : []
          }
          disabledReason={busy ? waitingForResponse : undefined}
        />
      </Suspense>
    );
  // A later reply's notice counts this one.
  const folded = failedRun;
  if (folded === 0) return null;
  // The reason in the original's words, never the engine's own text; Continue
  // carries on where the reply stopped, the clearer way out of an interruption.
  return (
    <ReplyBanner
      mode={mode}
      role="alert"
      buttons={
        retryable
          ? [
              { label: "Try again", onClick: onRetry },
              { label: "Continue", onClick: onContinue },
            ]
          : []
      }
      disabledReason={busy ? waitingForResponse : undefined}
    >
      {folded && folded > 1
        ? formatText("{count} responses didn’t load.", { count: folded })
        : failureMessage(turn.error)}
    </ReplyBanner>
  );
}

/** "Rate limit reached. Retrying now (attempt 2 of 5)". */
export function retryingText(attempt: string, cause?: RetryCause) {
  const [current, total] = attempt.split("/");
  return formatText(
    "{cause}. Retrying now (attempt {attempt} of {maxRetries})",
    {
      cause: t(cause ? retryCauseHeadlines[cause] : "Request failed"),
      attempt: current,
      maxRetries: total,
    },
  );
}
