import { formatText, t } from "../i18n";
import type { GitHubPullRequest } from "../../shared/github-api";
import { WithTooltip } from "../ui/Tooltip";

/**
 * The bar's review chips (live claude.ai bundle, 2026-10-14): whose turn
 * the request is ("Your turn" on the accent, "Their turn" muted, with an
 * arrow) and the open review threads (a Chat glyph and their count).
 * Glyphs: the icon font's Chat, ArrowRight and ArrowLeft at 16px, 533.3.
 */
const glyphs = {
  Chat: "m8 1.83q1.28 0 2.39.48q1.12.48 1.97 1.33q.85.85 1.33 1.97q.48 1.12.48 2.39q0 1.28-.48 2.34q-.48 1.06-1.32 1.83q-.84.77-1.97 1.18q-1.13.42-2.4.42h-5.6q-.26 0-.41-.16q-.15-.17-.16-.4q-.01-.24.16-.42l1.65-1.63q-.18.17-.18.4q0 .23.18.4q-.54-.54-.94-1.12q-.41-.58-.64-1.27q-.23-.69-.23-1.57q0-1.28.48-2.39q.48-1.12 1.33-1.97q.85-.85 1.97-1.33q1.12-.48 2.39-.48zm0 1.14q-1.04 0-1.95.39q-.91.39-1.6 1.08q-.7.7-1.09 1.6q-.39.91-.39 1.95q0 1.01.38 1.73q.38.72 1.09 1.44q.18.17.18.4q0 .23-.18.4l-1.63 1.65q.17-.18.16-.41q-.01-.23-.16-.4q-.15-.17-.41-.17h5.6q1.03 0 1.95-.33q.91-.32 1.6-.94q.7-.62 1.09-1.46q.39-.85.39-1.9q0-1.04-.39-1.95q-.39-.91-1.08-1.6q-.7-.7-1.61-1.09q-.9-.39-1.95-.39zm-2.99 6q-.24 0-.41-.16q-.17-.17-.17-.41q0-.24.17-.41q.17-.16.41-.16l.14-.03l.17-.12l.19-.2l.17-.31q.1-.22.31-.3q.22-.09.42 0q.21.08.31.3l.17.31l.19.2l.17.12l.16.03l.15-.04l.15-.1l.19-.21l.18-.31q.1-.22.31-.3q.22-.09.42 0q.21.08.31.3l.17.31l.19.2l.17.12l.16.03l.14-.03l.17-.12l.19-.2l.17-.31q.08-.2.3-.29q.23-.1.45 0q.2.09.29.31q.1.22 0 .44q-.1.25-.27.5q-.17.24-.4.43q-.22.19-.49.3q-.26.11-.55.11q-.31 0-.58-.11q-.27-.11-.49-.3l-.13-.13l-.15.13q-.22.19-.49.3q-.27.11-.56.11q-.31 0-.58-.11q-.27-.11-.49-.3l-.13-.13l-.15.13q-.22.19-.49.3q-.27.11-.56.11z",
  ArrowRight:
    "m3.6 8.57q-.24 0-.41-.16q-.16-.17-.16-.41q0-.24.16-.41q.17-.16.41-.16h7.42l-3.03-3.02q-.16-.17-.16-.41q0-.24.16-.41q.17-.16.41-.16q.24 0 .41.16l4 4q.17.18.16.41q-.01.23-.16.4q-.15.17-.41.17zm5.21 3.84q-.17.16-.41.16q-.24 0-.41-.16q-.16-.17-.16-.41q0-.24.16-.41l4-4l.82.82z",
  ArrowLeft:
    "m12.4 7.43q.24 0 .41.16q.16.17.16.41q0 .24-.16.41q-.17.16-.41.16h-8.8q-.26 0-.41-.16q-.15-.17-.16-.4q-.01-.24.16-.42l4-4q.17-.16.41-.16q.24 0 .41.16q.16.17.16.41q0 .24-.16.41l-3.03 3.02zm-4.39 4.16q.16.17.16.41q0 .24-.16.41q-.17.16-.41.16q-.24 0-.41-.16l-4-4l.82-.82z",
} as const;

function Glyph({ name }: { name: keyof typeof glyphs }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={glyphs[name]} />
    </svg>
  );
}

/**
 * Whose move it is on an open request the account opened: theirs while
 * reviewers have it; the account's when changes were asked for, a thread
 * waits on its answer, a check fails, it conflicts, or it was approved.
 */
export function reviewTurn(pr: GitHubPullRequest): boolean | undefined {
  if (pr.state !== "open" || pr.viewerIsAuthor === false) return undefined;
  if (
    pr.review === "changesRequested" ||
    (pr.unansweredReviewThreads ?? 0) > 0 ||
    pr.checks === "failed" ||
    pr.conflicting ||
    pr.review === "approved"
  )
    return true;
  return false;
}

export function ReviewTurnChip({ yours }: { yours: boolean }) {
  const label = yours ? t("Your turn") : t("Their turn");
  const reason = yours
    ? t("This change is waiting on you.")
    : t("Waiting on reviewers.");
  return (
    <WithTooltip label={reason} size="wrap" placement="above">
      {(tip) => (
        <span
          {...tip}
          role="img"
          aria-label={formatText("{label}: {reason}", { label, reason })}
          className="pr-turn"
          data-yours={yours || undefined}
        >
          <Glyph name={yours ? "ArrowRight" : "ArrowLeft"} />
          <span className="pr-turn-label">{label}</span>
        </span>
      )}
    </WithTooltip>
  );
}

export function ReviewCommentsChip({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  const label =
    count === 1
      ? t("Open review comments, 1 open thread")
      : formatText("Open review comments, {count} open threads", { count });
  return (
    <WithTooltip label={label} placement="above">
      {(tip) => (
        <button
          {...tip}
          type="button"
          className="pr-comments"
          aria-label={label}
          onClick={onClick}
        >
          <Glyph name="Chat" />
          <span>{count}</span>
        </button>
      )}
    </WithTooltip>
  );
}
