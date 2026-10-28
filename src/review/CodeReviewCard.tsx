import { useContext, useState } from "react";
import { ChevronRight } from "../ui/glyphs";
import type { Item } from "../../shared/types";
import { api } from "../desktop-api";
import { AppContext } from "../app/AppContext";
import { formatText, t } from "../i18n";
import { Markdown } from "../ui/Markdown";
import {
  fileName,
  findingsByFile,
  parseReviewOutput,
  type ReviewFinding,
} from "./review-output";
import "./code-review.css";

/** "1 finding" / "3 findings": the official card's count. */
const findingCount = (count: number) =>
  count === 1 ? t("1 finding") : formatText("{count} findings", { count });

/**
 * The end of a `/review` (Codex's `exitedReviewMode`): a Code review card
 * like the original's findings card, "Code review · N findings" with
 * Re-run review, then the findings grouped by file, each a row that opens
 * to its text. Codex gives the review as text, which review-output.ts reads
 * back into findings; a text without findings (the overall explanation, or
 * "Reviewer failed to output a response.") is shown as it is.
 */
export function CodeReviewCard({ item }: { item: Item }) {
  const app = useContext(AppContext);
  const output = parseReviewOutput(
    typeof item.review === "string" ? item.review : "",
  );
  const [busy, setBusy] = useState(false);
  const active = app?.active;
  const turn = active?.turns.find((value) =>
    value.items.some((other) => other.id === item.id),
  );
  // Re-run review: the same target again, on the latest review only.
  const rerun =
    app &&
    active &&
    turn?.review &&
    turn === active.turns.at(-1) &&
    !app.running
      ? () => {
          setBusy(true);
          app.follow.current = true;
          api
            .startReview(active.id, turn.review!, turn.prompt)
            .then((conversation) => app.upsert(conversation))
            .catch(app.report)
            .finally(() => setBusy(false));
        }
      : undefined;
  const count = output.findings.length;
  return (
    <section className="code-review" aria-label="Code review">
      <div className="code-review-head">
        <span className="code-review-title">Code review</span>
        {count > 0 && (
          <span className="code-review-count">{findingCount(count)}</span>
        )}
        <span className="code-review-grow" />
        {rerun && (
          <button
            type="button"
            className="code-review-rerun"
            disabled={busy || app?.sending}
            onClick={rerun}
          >
            Re-run review
          </button>
        )}
      </div>
      {output.failed ? (
        <p className="code-review-note">
          Reviewer failed to output a response.
        </p>
      ) : (
        output.summary && (
          <div className="markdown code-review-summary">
            <Markdown text={output.summary} />
          </div>
        )
      )}
      {count > 0 && (
        <div className="code-review-files">
          {findingsByFile(output.findings).map((group, groupIndex) => (
            <div
              className="code-review-file"
              key={`${group.path}:${groupIndex}`}
            >
              <div
                className="code-review-path"
                title={group.path}
                data-no-translate
              >
                {fileName(group.path) || "—"}
              </div>
              <ul>
                {group.entries.map(({ finding, index }) => (
                  <FindingRow key={index} finding={finding} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: ReviewFinding }) {
  const [open, setOpen] = useState(false);
  const where = finding.path
    ? finding.start !== undefined
      ? `${finding.path}:${finding.start}${finding.end && finding.end !== finding.start ? `-${finding.end}` : ""}`
      : finding.path
    : "";
  return (
    <li className="code-review-finding">
      <button
        type="button"
        className="code-review-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {finding.priority !== undefined && (
          <span className="code-review-badge">P{finding.priority}</span>
        )}
        <span className="code-review-summary-line" data-no-translate>
          <span className="sr-only">{where}. </span>
          {finding.title}
        </span>
        <ChevronRight size={13} data-open={open || undefined} />
      </button>
      {open && (
        <div className="code-review-detail">
          {finding.body && (
            <div className="markdown">
              <Markdown text={finding.body} />
            </div>
          )}
          {where && (
            <span className="code-review-where" title={where} data-no-translate>
              {where}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
