import type { DiffFinding, FindingStatus } from "../review/diff-findings";
import { formatText, t } from "../i18n";
import { Star } from "../ui/Star";
import { ThreadIcon } from "./review-thread-glyphs";
import "./review-thread.css";

/**
 * A review finding at its line in the Changes panel: Claude's mark and name,
 * "Line N", Fixing… or Fixed, Next finding and Dismiss finding; the finding and
 * its failure scenario; "Fix this one" while it is open.
 */
export function ReviewFindingCard({
  finding,
  status,
  onFix,
  onNext,
  onDismiss,
}: {
  finding: DiffFinding;
  status: FindingStatus;
  onFix?: () => void;
  onNext?: () => void;
  onDismiss: () => void;
}) {
  const end = finding.line;
  const start = finding.startLine ?? end;
  const open = status === "open" && Boolean(onFix);
  const next = t("Next finding");
  return (
    <div className="review-thread-wrap">
      <div className="review-thread" tabIndex={-1}>
        <div className="review-thread-head">
          <Star size={16} />
          <span className="review-thread-author">
            <span>Claudex</span>
          </span>
          {end !== undefined && (
            <span className="review-thread-line">
              {start === end
                ? formatText("Line {line}", { line: end })
                : formatText("Lines {start}–{end}", { start: start!, end })}
            </span>
          )}
          <div className="review-thread-tools">
            {status === "addressed" ? (
              <span className="review-thread-badge" data-tone="success">
                {t("Fixed")}
              </span>
            ) : status === "fixing" ? (
              <span className="review-thread-badge">{t("Fixing…")}</span>
            ) : null}
            {status === "open" && onNext && (
              <button
                type="button"
                className="review-thread-icon"
                aria-label={
                  end === undefined
                    ? next
                    : formatText("Next finding after the one on line {line}", {
                        line: end,
                      })
                }
                title={next}
                onClick={onNext}
              >
                <ThreadIcon name="ArrowDown" />
              </button>
            )}
            <button
              type="button"
              className="review-thread-icon"
              aria-label={t("Dismiss finding")}
              onClick={onDismiss}
            >
              <ThreadIcon name="X" />
            </button>
          </div>
        </div>
        <div className="review-finding-body" data-open={open || undefined}>
          <p className="review-thread-text">{finding.title}</p>
          {finding.body.trim() && (
            <p className="review-thread-text review-finding-detail">
              {finding.body.trim()}
            </p>
          )}
        </div>
        {open && (
          <div className="review-finding-foot">
            <button
              type="button"
              className="secondary review-thread-send"
              onClick={onFix}
            >
              <ThreadIcon name="ArrowUp" />
              {t("Fix this one")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
