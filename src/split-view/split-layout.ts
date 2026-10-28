/**
 * The split view's layout rules, apart from React and the stores so they run
 * under the unit tests. The window shows its own conversation (the primary
 * pane, always the top cell of the first column) and up to nine more beside
 * and below it: columns of at most two cells, as many columns as the window
 * is wide enough for (source: ion bundle, the pane store and its layout
 * helpers).
 *
 * A cell is `{ col, row }`; row 0 is the top. The primary pane never appears
 * in the list of panes, so no pane may claim `{ 0, 0 }`. `focus` counts the
 * primary pane as 0 and the listed panes as 1, 2, … in list order.
 */

import type { SplitMenuState } from "../../shared/menu-state";

/** Most columns the window can hold (the original's limit). */
export const MAX_COLUMNS = 5;
/** Each column needs this much width to count (CSS px). */
export const COLUMN_MIN_WIDTH = 360;
/** The least a pane may be resized to (CSS px). */
export const PANE_MIN_PX = 320;

/** How the two rows of a column divide the height (a share for the top row). */
export const rowSplitLimits = { min: 0.15, max: 0.85, default: 0.5 } as const;

export type PaneRef =
  | { kind: "session"; id: string }
  /** A new session waiting for its first message. */
  | { kind: "draft"; nonce: number };

export interface PanePos {
  col: number;
  row: number;
}

export interface PaneEntry {
  /** Names the pane's place while its session changes (a draft becomes one). */
  key: string;
  ref: PaneRef;
  pos: PanePos;
}

export type Direction = "left" | "right" | "up" | "down";

/** How many columns fit a host this wide (1 to 5). */
export function maxColumnsFor(width: number) {
  const fits = Math.floor(width / COLUMN_MIN_WIDTH);
  return Math.max(1, Math.min(MAX_COLUMNS, fits || 1));
}

export const isDraft = (ref: PaneRef) => ref.kind === "draft";

export const refKey = (ref: PaneRef) =>
  ref.kind === "draft" ? `draft:${ref.nonce}` : `session:${ref.id}`;

export const sameRef = (a: PaneRef, b: PaneRef) => refKey(a) === refKey(b);

export const samePos = (a: PanePos, b: PanePos) =>
  a.col === b.col && a.row === b.row;

/** How many columns the panes (and the primary pane's) take. */
export function columnCount(panes: readonly PaneEntry[]) {
  return panes.reduce((most, pane) => Math.max(most, pane.pos.col), 0) + 1;
}

/** Whether the column has a top cell (the first column always does: the primary pane). */
export const hasTop = (panes: readonly PaneEntry[], col: number) =>
  col === 0 || panes.some((p) => p.pos.col === col && p.pos.row === 0);

/** Whether the column has a bottom cell. */
export const hasBottom = (panes: readonly PaneEntry[], col: number) =>
  panes.some((p) => p.pos.col === col && p.pos.row === 1);

/** The list index of the pane in a cell, or -1. */
export const paneAt = (panes: readonly PaneEntry[], pos: PanePos) =>
  panes.findIndex((p) => samePos(p.pos, pos));

/** The list index of the pane showing the reference, or -1. */
export const paneFor = (panes: readonly PaneEntry[], ref: PaneRef) =>
  panes.findIndex((p) => sameRef(p.ref, ref));

/** The cell of a focus index (0 is the primary pane). */
export function posOfFocus(panes: readonly PaneEntry[], focus: number) {
  if (focus <= 0) return { col: 0, row: 0 };
  return panes[focus - 1]?.pos ?? { col: 0, row: 0 };
}

/**
 * Tidies a list of panes: nothing may sit in the primary pane's cell (it moves
 * below it, or is dropped when that cell is taken), columns have no gaps, and
 * a lone bottom cell of a column rises to the top.
 */
export function normalize(panes: readonly PaneEntry[]): PaneEntry[] {
  if (!panes.length) return [];
  let bottomTaken = panes.some((p) => p.pos.col === 0 && p.pos.row === 1);
  const kept: PaneEntry[] = [];
  for (const pane of panes) {
    if (pane.pos.col === 0 && pane.pos.row === 0) {
      if (bottomTaken) continue;
      bottomTaken = true;
      kept.push({ ...pane, pos: { col: 0, row: 1 } });
    } else kept.push(pane);
  }
  if (!kept.length) return [];
  const columns = Array.from(new Set([0, ...kept.map((p) => p.pos.col)])).sort(
    (a, b) => a - b,
  );
  const compact = kept.map((p) => ({
    ...p,
    pos: { col: columns.indexOf(p.pos.col), row: p.pos.row },
  }));
  return compact.map((p) =>
    p.pos.col > 0 &&
    p.pos.row === 1 &&
    !compact.some((q) => q.pos.col === p.pos.col && q.pos.row === 0)
      ? { ...p, pos: { col: p.pos.col, row: 0 } }
      : p,
  );
}

const layoutKey = (panes: readonly PaneEntry[]) =>
  panes
    .map((p) => `${p.pos.col}:${p.pos.row}=${refKey(p.ref)}`)
    .sort()
    .join("|");

/** Whether two lists hold the same panes in the same cells. */
export const sameLayout = (a: readonly PaneEntry[], b: readonly PaneEntry[]) =>
  a.length === b.length && layoutKey(a) === layoutKey(b);

/** The panes in reading order: column by column, top to bottom. */
export function readingOrder(panes: readonly PaneEntry[]) {
  return panes
    .map((entry, index) => ({ entry, focus: index + 1 }))
    .sort(
      (a, b) =>
        a.entry.pos.col - b.entry.pos.col || a.entry.pos.row - b.entry.pos.row,
    );
}

/** Focus indexes in reading order; the primary pane (0) leads. */
export const focusOrder = (panes: readonly PaneEntry[]) => [
  0,
  ...readingOrder(panes).map((p) => p.focus),
];

/** The focus index `step` places after `focus`, wrapping around. */
export function stepFocus(
  panes: readonly PaneEntry[],
  focus: number,
  step: 1 | -1,
) {
  const order = focusOrder(panes);
  const at = Math.max(0, order.indexOf(Math.min(focus, panes.length)));
  return order[(at + step + order.length) % order.length];
}

/** The focus index of a cell, or null when nothing is there. */
function focusAt(panes: readonly PaneEntry[], pos: PanePos) {
  if (pos.col === 0 && pos.row === 0) return 0;
  const index = paneAt(panes, pos);
  return index === -1 ? null : index + 1;
}

/**
 * The pane an arrow key moves the focus to: the neighbour in that direction;
 * from the bottom of a column the top cell stands in for a missing neighbour.
 */
export function arrowFocus(
  panes: readonly PaneEntry[],
  focus: number,
  direction: Direction,
) {
  const from = posOfFocus(panes, focus);
  const columns = columnCount(panes);
  let target: PanePos | null = null;
  if (direction === "left" && from.col > 0)
    target = { col: from.col - 1, row: from.row };
  else if (direction === "right" && from.col < columns - 1)
    target = { col: from.col + 1, row: from.row };
  else if (direction === "up" && from.row === 1)
    target = { col: from.col, row: 0 };
  else if (direction === "down" && from.row === 0)
    target = { col: from.col, row: 1 };
  if (!target) return null;
  const found = focusAt(panes, target);
  if (found !== null) return found;
  return target.row === 1 ? focusAt(panes, { col: target.col, row: 0 }) : null;
}

/** A free cell for a new pane: a new column while there is room, else a free bottom cell. */
export function freeCell(
  panes: readonly PaneEntry[],
  maxColumns: number,
): PanePos | null {
  const columns = columnCount(panes);
  if (columns < maxColumns) return { col: columns, row: 0 };
  for (let col = 0; col < columns; col++)
    if (!hasBottom(panes, col)) return { col, row: 1 };
  return null;
}

/**
 * Where a session opened in split view goes by default: a free cell, else
 * the cell of the last pane that is not a draft (it is replaced).
 */
export function defaultCell(
  panes: readonly PaneEntry[],
  maxColumns: number,
): PanePos {
  const free = freeCell(panes, maxColumns);
  if (free) return free;
  const order = readingOrder(panes).reverse();
  const last = order.find((p) => !isDraft(p.entry.ref)) ?? order[0];
  return last?.entry.pos ?? { col: 0, row: 1 };
}

export interface Placement {
  panes: PaneEntry[];
  /** The focus index of the pane that was added or replaced. */
  focus: number;
  /** A column was added: the columns start from equal widths again. */
  columnsChanged: boolean;
}

/**
 * Puts a pane in (or near) a cell. A cell past the last column opens a new
 * one while there is room, else lands in the last column; a bottom cell in a
 * column without a top cell becomes the top; a pane already in the cell is
 * replaced, except a draft, which moves to a free cell. Null: there was no
 * room for the draft that had to move.
 */
export function placePane(
  panes: readonly PaneEntry[],
  entry: Pick<PaneEntry, "key" | "ref">,
  wanted: PanePos,
  maxColumns: number,
): Placement | null {
  const columns = columnCount(panes);
  if (wanted.col < 0) return null;
  let cell: PanePos =
    wanted.col === 0 && wanted.row === 0 ? { col: 0, row: 1 } : wanted;
  if (cell.col >= columns) {
    if (columns < maxColumns) cell = { col: columns, row: 0 };
    else {
      const last = columns - 1;
      cell = { col: last, row: hasBottom(panes, last) ? 0 : 1 };
    }
  }
  if (cell.row === 1 && !hasTop(panes, cell.col))
    cell = { col: cell.col, row: 0 };
  if (cell.col === 0 && cell.row === 0) cell = { col: 0, row: 1 };
  const occupied = paneAt(panes, cell);
  const added: PaneEntry = { ...entry, pos: cell };
  if (occupied !== -1) {
    if (isDraft(panes[occupied].ref)) {
      const free = freeCell(panes, maxColumns);
      if (!free) return null;
      const moved = panes.map((p, i) =>
        i === occupied ? { ...p, pos: free } : p,
      );
      const next = normalize([...moved, added]);
      return {
        panes: next,
        focus: paneFor(next, added.ref) + 1,
        columnsChanged: free.col >= columns,
      };
    }
    const next = panes.map((p, i) =>
      i === occupied ? { ...p, ref: entry.ref } : p,
    );
    return { panes: next, focus: occupied + 1, columnsChanged: false };
  }
  const next = normalize([...panes, added]);
  return {
    panes: next,
    focus: paneFor(next, added.ref) + 1,
    columnsChanged: cell.col >= columns,
  };
}

/** Whether New Session on the Right has room: another column fits. */
export const canOpenRight = (panes: readonly PaneEntry[], maxColumns: number) =>
  columnCount(panes) < maxColumns;

/** Whether New Session Below has room: the focused pane's column has no bottom cell yet. */
export const canOpenBelow = (panes: readonly PaneEntry[], focus: number) =>
  !hasBottom(panes, posOfFocus(panes, focus).col);

/** The cell New Session on the Right opens in, or null with no room. */
export const rightCell = (
  panes: readonly PaneEntry[],
  maxColumns: number,
): PanePos | null =>
  canOpenRight(panes, maxColumns) ? { col: columnCount(panes), row: 0 } : null;

/** The cell New Session Below opens in, or null when the column is full. */
export const belowCell = (
  panes: readonly PaneEntry[],
  focus: number,
): PanePos | null =>
  canOpenBelow(panes, focus)
    ? { col: posOfFocus(panes, focus).col, row: 1 }
    : null;

/** The list without the pane (a focus index above 0), tidied. */
export function removePane(panes: readonly PaneEntry[], focus: number) {
  return normalize(panes.filter((_, index) => index !== focus - 1));
}

/** The focus after the pane at `closed` left a list that now holds `remaining` panes. */
export function focusAfterClose(
  focus: number,
  closed: number,
  remaining: number,
) {
  return closed < focus ? focus - 1 : Math.min(focus, remaining);
}

const neighbour = (pos: PanePos, direction: Direction): PanePos | null => {
  if (direction === "left")
    return pos.col > 0 ? { col: pos.col - 1, row: pos.row } : null;
  if (direction === "right") return { col: pos.col + 1, row: pos.row };
  if (direction === "up")
    return pos.row === 1 ? { col: pos.col, row: 0 } : null;
  return pos.row === 0 ? { col: pos.col, row: 1 } : null;
};

export interface Move {
  panes: PaneEntry[];
  /** The focus index of the pane that moved. */
  focus: number;
  /** A session that takes over the primary pane (swapped with it). */
  promoted?: string;
  columnsChanged: boolean;
}

/**
 * Moves the focused pane one cell in a direction. An occupied cell swaps; a
 * free one takes the pane (a new column to the right while there is room).
 * The primary pane only swaps, with a pane that holds a session, and a pane
 * swaps with the primary pane only when the primary pane holds a session
 * (`primary`) and the pane is not a draft. Null: the move changes nothing.
 */
export function movePane(
  panes: readonly PaneEntry[],
  focus: number,
  direction: Direction,
  maxColumns: number,
  primary: PaneRef | null,
): Move | null {
  const from = posOfFocus(panes, focus);
  const to = neighbour(from, direction);
  if (!to) return null;
  const columns = columnCount(panes);
  if (to.col >= maxColumns || to.col > columns) return null;
  // A new column takes a top cell only.
  if (to.col === columns && to.row !== 0) return null;
  if (to.row === 1 && to.col < columns && !hasTop(panes, to.col)) return null;
  const there = focusAt(panes, to);
  // Swaps with the primary pane.
  if (focus === 0 || there === 0) {
    const other = focus === 0 ? there : focus;
    if (other === null || other === 0 || !primary) return null;
    const pane = panes[other - 1];
    if (pane.ref.kind !== "session") return null;
    const next = panes.map((p, i) =>
      i === other - 1 ? { ...p, ref: primary } : p,
    );
    // The pane that moves keeps the focus: the old primary session now in
    // the slot, or the promoted session in the primary pane.
    return {
      panes: next,
      focus: focus === 0 ? other : 0,
      promoted: pane.ref.id,
      columnsChanged: false,
    };
  }
  const index = focus - 1;
  if (there !== null) {
    const swapped = panes.map((p, i) =>
      i === index
        ? { ...p, pos: panes[there - 1].pos }
        : i === there - 1
          ? { ...p, pos: panes[index].pos }
          : p,
    );
    const next = normalize(swapped);
    if (sameLayout(panes, next)) return null;
    return {
      panes: next,
      focus: paneFor(next, panes[index].ref) + 1,
      columnsChanged: false,
    };
  }
  const moved = panes.map((p, i) => (i === index ? { ...p, pos: to } : p));
  const next = normalize(moved);
  if (sameLayout(panes, next)) return null;
  return {
    panes: next,
    focus: paneFor(next, panes[index].ref) + 1,
    columnsChanged: columnCount(next) !== columns,
  };
}

/** Which moves the focused pane has, for the menu. */
export function moveDirections(
  panes: readonly PaneEntry[],
  focus: number,
  maxColumns: number,
  primary: PaneRef | null,
): Record<Direction, boolean> {
  const can = (direction: Direction) =>
    movePane(panes, focus, direction, maxColumns, primary) !== null;
  return {
    left: can("left"),
    right: can("right"),
    up: can("up"),
    down: can("down"),
  };
}

/** What the Split View menu may do now. */
export function splitMenuState(
  panes: readonly PaneEntry[],
  focus: number,
  maxColumns: number,
  primary: PaneRef | null,
): SplitMenuState {
  const moves = moveDirections(panes, focus, maxColumns, primary);
  return {
    newRight: canOpenRight(panes, maxColumns),
    newBelow: canOpenBelow(panes, focus),
    split: panes.length > 0,
    moveLeft: moves.left,
    moveRight: moves.right,
    moveUp: moves.up,
    moveDown: moves.down,
  };
}

/**
 * Fits the panes to the columns the window has room for: columns past the
 * last that fits are parked (kept, not shown), and parked panes come back
 * when room returns. As in the original, nothing is lost by a narrow window.
 */
export function fitColumns(
  panes: readonly PaneEntry[],
  parked: readonly PaneEntry[],
  maxColumns: number,
) {
  let shown = [...panes];
  let held = [...parked];
  if (columnCount(shown) > maxColumns) {
    held = [...shown.filter((p) => p.pos.col >= maxColumns), ...held];
    shown = normalize(shown.filter((p) => p.pos.col < maxColumns));
  }
  if (held.length) {
    const rest: PaneEntry[] = [];
    // A parked column returns as one new column, once there is room for it.
    const returned = new Map<number, number>();
    const order = [...held].sort(
      (a, b) => a.pos.col - b.pos.col || a.pos.row - b.pos.row,
    );
    for (const entry of order) {
      let col = returned.get(entry.pos.col);
      if (col === undefined) {
        if (columnCount(shown) >= maxColumns) {
          rest.push(entry);
          continue;
        }
        col = columnCount(shown);
        returned.set(entry.pos.col, col);
      }
      shown = normalize([
        ...shown,
        { ...entry, pos: { col, row: entry.pos.row } },
      ]);
    }
    held = rest;
  }
  return { panes: shown, parked: held };
}

/** The columns' widths as equal shares, or the saved ones when they fit. */
export function columnWeights(
  saved: readonly number[] | undefined,
  count: number,
) {
  return saved && saved.length === count && saved.every((w) => w > 0)
    ? [...saved]
    : Array.from({ length: count }, () => 1);
}

/** The grid tracks for the columns' weights. */
export const columnTracks = (weights: readonly number[]) =>
  weights.map((w) => `minmax(0, ${w}fr)`).join(" ");

/**
 * Moves the divider between column `index` and the next by `delta` weight,
 * leaving both at least `least` (and at most half of their sum when that is
 * smaller). The other columns keep their weights.
 */
export function resizeColumns(
  weights: readonly number[],
  index: number,
  delta: number,
  least: number,
) {
  const next = [...weights];
  const sum = weights[index] + weights[index + 1];
  const floor = Math.min(least, sum / 2);
  const left = Math.min(sum - floor, Math.max(floor, weights[index] + delta));
  next[index] = left;
  next[index + 1] = sum - left;
  return next;
}

/** The weight that stands for `PANE_MIN_PX` in a host of this width and total weight. */
export const leastWeight = (width: number, total: number) =>
  (PANE_MIN_PX / Math.max(1, width)) * total;

/** The range the rows' divider may take in a host this tall (a share for the top row). */
export function rowSplitRange(height: number) {
  const least = Math.max(rowSplitLimits.min, PANE_MIN_PX / Math.max(1, height));
  return least < 0.5 ? { min: least, max: 1 - least } : { min: 0.5, max: 0.5 };
}

export const clampRowSplit = (value: number, height: number) => {
  const { min, max } = rowSplitRange(height);
  return Math.min(max, Math.max(min, value));
};
