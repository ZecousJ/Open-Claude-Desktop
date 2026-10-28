/*
 * A Markdown document's contents rail (MarkdownRail.tsx), after the The first
 * three heading levels (h1–h3), shown once there are three of them. Levels
 * count from the highest one present; a lone top heading that opens the
 * document (its title) stands at the first level and the rest start one level
 * lower, down to the third. Every heading is a rail tick: a long outline
 * scrolls the rail instead of dropping levels. The heading being read is the
 * last one above a line 20% down the view, the first one before any scroll and
 * the last one once the view reaches the end.
 */

export interface OutlineEntry {
  /** Index into the document's headings, in order. */
  index: number;
  text: string;
  /** 0 for the top level, 1 below it, 2 below that. */
  depth: number;
}

/** The deepest heading level listed (h3), and the fewest headings shown. */
const MAX_LEVEL = 3;
const MIN_ENTRIES = 3;
/** Where the reading line sits, as a share of the view's height. */
export const READING_LINE = 0.2;
/** A rail tick's row (px). */
export const RAIL_TICK_PX = 8;
/** Room kept around the current tick when the rail scrolls (px). */
export const RAIL_BUFFER_PX = 40;

/** The outline of the headings (level 1 for h1…), or none under three. */
export function documentOutline(
  headings: { level: number; text: string }[],
): OutlineEntry[] {
  const listed = headings
    .map((heading, index) => ({ ...heading, index, text: heading.text.trim() }))
    .filter((heading) => heading.level <= MAX_LEVEL && heading.text);
  if (listed.length < MIN_ENTRIES) return [];
  const top = Math.min(...listed.map((heading) => heading.level));
  const titled =
    listed[0].level === top &&
    listed.filter((heading) => heading.level === top).length === 1;
  return listed.map((heading, i) => ({
    index: heading.index,
    text: heading.text,
    depth: Math.max(
      0,
      Math.min(heading.level - top - (titled && i > 0 ? 1 : 0), 2),
    ),
  }));
}

/**
 * The entry being read, from each entry's heading top relative to the
 * view's top. At the very top the first heading; at the very end the last.
 */
export function activeEntry(
  entries: OutlineEntry[],
  tops: number[],
  view: { scrollTop: number; clientHeight: number; scrollHeight: number },
): OutlineEntry | undefined {
  if (!entries.length) return undefined;
  if (view.scrollTop <= 0) return entries[0];
  if (
    view.scrollHeight > view.clientHeight &&
    view.scrollHeight - view.scrollTop - view.clientHeight <= 8
  )
    return entries.at(-1);
  const line = view.clientHeight * READING_LINE;
  let found = entries[0];
  entries.forEach((entry, i) => {
    if (tops[i] < line) found = entry;
  });
  return found;
}

/**
 * Where a scrolling rail stands so the row at `at` (with `size`) keeps
 * `buffer` of room above and below it in a `view` tall window; unchanged
 * while it already does.
 */
export function keepInView({
  scrollTop,
  view,
  at,
  size,
  buffer,
}: {
  scrollTop: number;
  view: number;
  at: number;
  size: number;
  buffer: number;
}) {
  if (at - buffer < scrollTop) return Math.max(0, at - buffer);
  if (at + size + buffer > scrollTop + view) return at + size + buffer - view;
  return scrollTop;
}
