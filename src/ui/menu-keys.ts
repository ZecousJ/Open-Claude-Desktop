/*
 * The menu's keyboard and pointer rules, kept apart from the component so they
 * can be tested: arrows loop, Home/End jump to the ends, typing a row's first
 * letters moves to it, and a pointer heading diagonally for an open submenu
 * does not switch rows on the way.
 */

/** Hovering a submenu row opens its submenu after this long. */
export const SUBMENU_OPEN_DELAY_MS = 100;
/**
 * Typed letters are forgotten after this pause: the original's menu root sets
 * `resetMs: 500` over Base UI's 750 default.
 */
export const TYPEAHEAD_RESET_MS = 500;

/**
 * The position (in `count` selectable rows) a navigation key moves to from
 * `current` (-1 when nothing is highlighted), or undefined for other keys.
 * The arrows loop round the ends.
 */
export function stepPosition(
  key: string,
  current: number,
  count: number,
): number | undefined {
  if (count === 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp")
    return current < 0 ? count - 1 : (current - 1 + count) % count;
  return undefined;
}

/**
 * The row typed letters point at. `labels` are the selectable rows' labels
 * in order and `current` the highlighted position. The same letter typed
 * again cycles through the rows that start with it; a longer prefix stays
 * on the current row while it still matches. -1 when nothing matches.
 */
export function typeaheadPosition(
  labels: string[],
  current: number,
  query: string,
): number {
  const typed = query.toLocaleLowerCase();
  if (!typed) return -1;
  const repeated = [...typed].every((char) => char === typed[0]);
  const prefix = repeated ? typed[0] : typed;
  // A repeated letter moves on from the current row; a longer prefix may
  // keep it.
  const start = repeated ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < labels.length; step++) {
    const position = (start + step) % labels.length;
    if (labels[position]?.trim().toLocaleLowerCase().startsWith(prefix))
      return position;
  }
  return -1;
}

type Point = { x: number; y: number };

/** Whether `p` lies inside the triangle a-b-c (edges included). */
export function insideTriangle(p: Point, a: Point, b: Point, c: Point) {
  const side = (u: Point, v: Point, w: Point) =>
    (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
  const d1 = side(p, a, b);
  const d2 = side(p, b, c);
  const d3 = side(p, c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/**
 * Whether a pointer at `p`, having left a submenu's row at `apex`, is on
 * its way to the submenu `box` beside the menu (the safe triangle from the
 * exit point to the submenu's near edge).
 */
export function headingForSubmenu(
  p: Point,
  apex: Point,
  box: { left: number; right: number; top: number; bottom: number },
) {
  const edge = box.left >= apex.x ? box.left : box.right;
  return insideTriangle(
    p,
    apex,
    { x: edge, y: box.top },
    { x: edge, y: box.bottom },
  );
}

/**
 * A row's accessible role. A row with no `checked` is a plain menu item; one
 * that has it is a checkbox, or, in a submenu list that chooses one value, a
 * radio, and then reports aria-checked.
 */
export function itemRole(
  checked: boolean | undefined,
  choice: "checkbox" | "radio",
): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  if (checked === undefined) return "menuitem";
  return choice === "radio" ? "menuitemradio" : "menuitemcheckbox";
}
