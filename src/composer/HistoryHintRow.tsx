import { formatText, t } from "../i18n";
import type { HistoryHint } from "./prompt-history";

/**
 * The composer's header while the prompt history is in use: "History
 * {index}/{total}" and, when a draft waits, "↓ to restore your draft"; while
 * searching, "Search history:" with the query and a blinking bar, red when
 * nothing matches, and the key hints "↑ ↓ cycle · esc cancel" fading in at the
 * end. A status line says the same to screen readers.
 */
export function HistoryHintRow({ hint }: { hint: HistoryHint }) {
  const spoken =
    hint.kind === "search"
      ? `${formatText("Search history: {query}", { query: hint.query })}${
          hint.failed
            ? ` — ${t("no match")}`
            : hint.matchIndex
              ? ` — ${formatText("match {index} of {total}", {
                  index: hint.matchIndex,
                  total: hint.total,
                })}`
              : ""
        }`
      : `${formatText("History {index}/{total}", {
          index: hint.index,
          total: hint.total,
        })}${hint.hasDraft ? ` ${t("↓ to restore your draft")}` : ""}`;
  return (
    <>
      <div className="composer-history-hint" aria-hidden="true">
        {hint.kind === "search" ? (
          <>
            <span data-failed={hint.failed || undefined}>
              {t("Search history:")}
            </span>
            <span className="composer-history-query">
              {hint.query}
              <span className="composer-history-bar">▎</span>
            </span>
            <span
              className="composer-history-keys"
              data-shown={hint.showHints || undefined}
            >
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              {t("cycle")}
              <span>·</span>
              <kbd>esc</kbd>
              {t("cancel")}
            </span>
          </>
        ) : (
          <>
            <span className="composer-history-count">
              {formatText("History {index}/{total}", {
                index: hint.index,
                total: hint.total,
              })}
            </span>
            {hint.hasDraft && (
              <>
                <span>·</span>
                <span>
                  <kbd>↓</kbd> {t("to restore your draft")}
                </span>
              </>
            )}
          </>
        )}
      </div>
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </>
  );
}
