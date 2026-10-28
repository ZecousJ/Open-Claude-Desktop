import type { Point, Bend, Mark, LineMark } from "./annotate-sketch";

/** `strokeWidth: 4`, `textSize` 16, redactions `#000000` with 4px corners. */
export const strokeWidth = 4;

export const box = (from: Point, to: Point) => ({
  x: Math.min(from.x, to.x),
  y: Math.min(from.y, to.y),
  width: Math.abs(to.x - from.x),
  height: Math.abs(to.y - from.y),
});

export const isLineMark = (mark: Mark): mark is LineMark =>
  mark.kind === "line" || mark.kind === "arrow";

export const distance = (a: Point, b: Point) =>
  Math.hypot(b.x - a.x, b.y - a.y);

/** Where a line's middle handle sits; on a straight line, its middle. */
export function bendHandle(mark: LineMark): Point {
  const dx = mark.to.x - mark.from.x;
  const dy = mark.to.y - mark.from.y;
  const { u, v } = mark.bend ?? { u: 0.5, v: 0 };
  return { x: mark.from.x + u * dx - v * dy, y: mark.from.y + u * dy + v * dx };
}

/** The control point of a bent line's curve. */
export function curveControl(mark: LineMark): Point {
  const handle = bendHandle(mark);
  return {
    x: 2 * handle.x - (mark.from.x + mark.to.x) / 2,
    y: 2 * handle.y - (mark.from.y + mark.to.y) / 2,
  };
}

/** The bend that puts the middle handle at `point` (none on a zero-length line). */
export function bendThrough(
  from: Point,
  to: Point,
  point: Point,
): Bend | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const squared = dx * dx + dy * dy;
  if (squared === 0) return undefined;
  const px = point.x - from.x;
  const py = point.y - from.y;
  return { u: (px * dx + py * dy) / squared, v: (py * dx - px * dy) / squared };
}

/** A copy of the line with the given bend, or straightened when there is none. */
export function withBend(mark: LineMark, bend: Bend | undefined): LineMark {
  const { bend: _old, ...rest } = mark;
  return bend ? { ...rest, bend } : rest;
}

export const curveSteps = 32;

export function onCurve(
  from: Point,
  control: Point,
  to: Point,
  t: number,
): Point {
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const c = t * t;
  return {
    x: a * from.x + b * control.x + c * to.x,
    y: a * from.y + b * control.y + c * to.y,
  };
}

/** The dashed frame around selected text sits 4px out. */
export const textFramePad = 4;

/** How close a pointer must come to a stroke: 6px (14px by touch), or 3px past its edge. */
export function strokeReach(width: number, scale: number, coarse = false) {
  return Math.max((coarse ? 14 : 6) * scale, width / 2 + 3 * scale);
}

/** A side gets its middle handle (a line its bend handle) from 48px. */
export const handleSpan = 48;

/** A bend dragged back within 4px of the line's middle straightens it. */
export const straightenReach = 4;

/** Text dragged by a corner grows or shrinks, down to 8px type. */
export const minTextSize = 8;

export const targetPad = 2;
