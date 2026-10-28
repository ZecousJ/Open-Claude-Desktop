import { Fragment, useMemo, type MouseEvent, type ReactNode } from "react";
import { splitRows, type DiffLine } from "./diff-model";
import { lineSegments } from "./highlight";
import { useLowlight } from "../ui/lazy-highlight";
import { t } from "../i18n";

/**
 * Numbered, coloured diff rows: line number, +/− mark, syntax-highlighted code
 * with the changed words emphasised.
 */
export function DiffLines({
  lines,
  language,
  markFirst = false,
  words = true,
  onComment,
  marked,
  afterRow,
}: {
  lines: DiffLine[];
  language?: string;
  /** New files put the + before the number. */
  markFirst?: boolean;
  /** Whether the words that changed within a line are emphasised. */
  words?: boolean;
  /** Add comment on this line (the Changes panel); shift extends a range. */
  onComment?: (index: number, event: MouseEvent) => void;
  /** Rows marked as commented on or being commented on. */
  marked?: (index: number) => boolean;
  /** Something shown under a row (the comment editor). */
  afterRow?: (index: number) => ReactNode;
}) {
  // Highlighting is the costly part of a large diff; redo it only when the
  // lines change, or the highlighter arrives.
  const lowlight = useLowlight(Boolean(language));
  const segments = useMemo(
    () =>
      lines.map((line) =>
        lineSegments(
          line.text,
          language,
          words ? line.changed : undefined,
          lowlight,
        ),
      ),
    [lines, language, words, lowlight],
  );
  return (
    <>
      {lines.map((line, index) => {
        const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
        const number = line.kind === "del" ? line.oldNo : line.newNo;
        return (
          <Fragment key={index}>
            <div
              className="diff-row"
              data-kind={line.kind}
              data-marked={marked?.(index) || undefined}
            >
              {onComment && (
                <button
                  type="button"
                  className="diff-comment-add"
                  aria-label={t("Add comment on this line")}
                  onClick={(event) => onComment(index, event)}
                >
                  +
                </button>
              )}
              <span className="diff-gutter">
                {markFirst ? (
                  <>
                    <span className="diff-mark">{mark}</span>
                    <span className="diff-number">{number}</span>
                  </>
                ) : (
                  <span className="diff-number">{number}</span>
                )}
              </span>
              {!markFirst && (
                <span className="diff-mark" aria-hidden={!mark}>
                  {mark}
                </span>
              )}
              <code className="diff-code">
                {segments[index].map((segment, i) => (
                  <span
                    key={i}
                    className={
                      [segment.className, segment.changed && "diff-word"]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  >
                    {segment.text}
                  </span>
                ))}
                {!line.text && "​"}
              </code>
            </div>
            {afterRow?.(index)}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Side by side: the old file's lines on the left, the new file's on the right,
 * each with its own number and mark; a change's removed and added lines pair up
 * row by row. A row's kind is its left side's change, else its right side's, so
 * the change keys (F7) land on it.
 */
export function SplitDiffLines({
  lines,
  language,
  words = true,
}: {
  lines: DiffLine[];
  language?: string;
  words?: boolean;
}) {
  const lowlight = useLowlight(Boolean(language));
  const rows = useMemo(() => splitRows(lines), [lines]);
  const segmentsOf = useMemo(() => {
    const cache = new Map<DiffLine, ReturnType<typeof lineSegments>>();
    return (line: DiffLine) => {
      let value = cache.get(line);
      if (!value) {
        value = lineSegments(
          line.text,
          language,
          words ? line.changed : undefined,
          lowlight,
        );
        cache.set(line, value);
      }
      return value;
    };
  }, [language, words, lowlight]);
  const half = (line: DiffLine | undefined, side: "left" | "right") => {
    if (!line) return <span className="diff-half" data-kind="empty" />;
    const changed = line.kind !== "context";
    const mark = changed ? (side === "left" ? "-" : "+") : "";
    const number = side === "left" ? line.oldNo : line.newNo;
    return (
      <span className="diff-half" data-kind={line.kind}>
        <span className="diff-gutter">
          <span className="diff-number">{number}</span>
        </span>
        <span className="diff-mark" aria-hidden={!mark}>
          {mark}
        </span>
        <code className="diff-code">
          {segmentsOf(line).map((segment, i) => (
            <span
              key={i}
              className={
                [segment.className, segment.changed && "diff-word"]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            >
              {segment.text}
            </span>
          ))}
          {!line.text && "\u200b"}
        </code>
      </span>
    );
  };
  return (
    <>
      {rows.map((row, index) => {
        const kind =
          row.left && row.left.kind !== "context"
            ? row.left.kind
            : row.right && row.right.kind !== "context"
              ? row.right.kind
              : "context";
        return (
          <div className="diff-row diff-split-row" data-kind={kind} key={index}>
            {half(row.left, "left")}
            {half(row.right, "right")}
          </div>
        );
      })}
    </>
  );
}
