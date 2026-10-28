/*
 * The tool dock's stacked cards share the column's height by weight (their
 * flex-grow). Dragging the divider between two cards moves height from one
 * to the other and leaves the rest alone; neither gets shorter than a
 * header and a few rows.
 */

/** The least height a stacked card keeps while its divider is dragged. */
export const MIN_ROW_PX = 120;

/**
 * The weights after the divider below card `index` moves `delta` px
 * (positive: down). `heights` are the cards' current heights; the result
 * is in the same unit, so every other card keeps its share.
 */
export function moveRowDivider(
  heights: number[],
  index: number,
  delta: number,
  min = MIN_ROW_PX,
) {
  const next = [...heights];
  const above = heights[index];
  const below = heights[index + 1];
  if (above === undefined || below === undefined) return next;
  const total = above + below;
  const floor = Math.min(min, total / 2);
  const moved = Math.max(floor, Math.min(total - floor, above + delta));
  next[index] = moved;
  next[index + 1] = total - moved;
  return next;
}

/** A card's share in the column: its CSS variable on the column. */
export function rowVariable(panel: string) {
  return `--tool-row-${panel}`;
}
