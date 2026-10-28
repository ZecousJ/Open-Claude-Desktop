/**
 * `@` file mentions in the Code composer: the query typed after an `@` at the
 * start of the text or after a space, and the text once a file is chosen.
 */
export interface MentionMatch {
  /** Index of the `@`. */
  start: number;
  /** What follows the `@` up to the caret. */
  query: string;
}

export function mentionAt(text: string, caret: number): MentionMatch | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

/** How a chosen path is written: `@path`, quoted when it has spaces. */
export function mentionToken(path: string) {
  return /\s/.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`;
}

/** The text with the `@query` replaced by the chosen path and a space; the caret goes after it. */
export function insertMention(
  text: string,
  match: MentionMatch,
  caret: number,
  path: string,
) {
  const token = mentionToken(path) + " ";
  const after = text.slice(caret).replace(/^ /, "");
  return {
    text: text.slice(0, match.start) + token + after,
    caret: match.start + token.length,
  };
}

/** A chosen mention in the draft: `text.slice(start, end)` is its token. */
export interface MentionRange {
  start: number;
  end: number;
}

/**
 * Where the chosen files' tokens stand in the draft: each `@path` token
 * written for a path in `paths`, starting the text or after a space and
 * followed by a space or the end. Typed text that only looks like one is not
 * a token.
 */
export function mentionRanges(
  text: string,
  paths: readonly string[],
): MentionRange[] {
  const ranges: MentionRange[] = [];
  for (const path of new Set(paths)) {
    const token = mentionToken(path);
    for (
      let at = text.indexOf(token);
      at >= 0;
      at = text.indexOf(token, at + 1)
    ) {
      const end = at + token.length;
      if (
        (at === 0 || /\s/.test(text[at - 1]!)) &&
        (end === text.length || /\s/.test(text[end]!))
      )
        ranges.push({ start: at, end });
    }
  }
  return ranges
    .sort((a, b) => a.start - b.start)
    .filter(
      (range, index, all) => index === 0 || range.start >= all[index - 1]!.end,
    );
}

/**
 * Backspace or Delete with a collapsed caret next to or inside a token takes
 * the whole token, as one character: Backspace after its end or inside it,
 * Delete before its start or inside it. Null when the key has its usual
 * effect.
 */
export function deleteMention(
  text: string,
  caret: number,
  ranges: readonly MentionRange[],
  key: "Backspace" | "Delete",
): { text: string; caret: number } | null {
  const hit = ranges.find((range) =>
    key === "Backspace"
      ? caret > range.start && caret <= range.end
      : caret >= range.start && caret < range.end,
  );
  if (!hit) return null;
  return {
    text: text.slice(0, hit.start) + text.slice(hit.end),
    caret: hit.start,
  };
}

/**
 * A selection never splits a token: a caret that lands inside one moves to
 * the edge it was heading for (its start when it came from after it, as an
 * arrow key left does, its end otherwise), and a selection that cuts one
 * widens to take it whole. The same range when it cuts none.
 */
export function snapToMentions(
  start: number,
  end: number,
  ranges: readonly MentionRange[],
  previousCaret?: number,
): { start: number; end: number } {
  if (start === end) {
    const inside = ranges.find(
      (range) => start > range.start && start < range.end,
    );
    if (!inside) return { start, end };
    const edge =
      previousCaret !== undefined && previousCaret > start
        ? inside.start
        : inside.end;
    return { start: edge, end: edge };
  }
  let from = start,
    to = end;
  for (const range of ranges) {
    if (from > range.start && from < range.end) from = range.start;
    if (to > range.start && to < range.end) to = range.end;
  }
  return { start: from, end: to };
}
