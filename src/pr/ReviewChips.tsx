import { ArrowLeft, ArrowRight, MessageCircle } from "lucide-react";
import { formatText, t } from "../i18n";
import type { GitHubPullRequest } from "../../shared/github-api";
import { WithTooltip } from "../ui/Tooltip";

/**
 * The bar's review chips: whose turn the request is ("Your turn" on the
 * accent, "Their turn" muted, with an arrow) and the open review threads
 * (a chat glyph and their count). Glyphs: Lucide at 16px.
 */
const glyphs = { Chat: MessageCircle, ArrowRight, ArrowLeft } as const;

function Glyph({ name }: { name: keyof typeof glyphs }) {
  const Icon = glyphs[name];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
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
