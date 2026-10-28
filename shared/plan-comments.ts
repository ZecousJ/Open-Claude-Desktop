export interface PlanComment {
  id: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  comment: string;
}

/** Revision wire text. */
export function planRevisionText(
  comments: readonly PlanComment[],
  feedback: string,
) {
  const note = feedback.trim();
  if (!comments.length) return note;
  const quoted = [...comments]
    .sort((left, right) => left.startOffset - right.startOffset)
    .map(
      (entry) =>
        `On selected text:\n${entry.selectedText
          .split(/\r\n?|[\n\u2028\u2029]/g)
          .map((line) => `> ${line}`)
          .join("\n")}\n${entry.comment}`,
    )
    .join("\n\n");
  return note ? `${quoted}\n\n\n${note}` : quoted;
}

export function overlapsPlanComment(
  comments: readonly PlanComment[],
  start: number,
  end: number,
) {
  return comments.some(
    (entry) => start < entry.endOffset && entry.startOffset < end,
  );
}
