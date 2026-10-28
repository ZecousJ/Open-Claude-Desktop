import {
  strokeWidth,
  box,
  isLineMark,
  distance,
  bendHandle,
  curveControl,
  bendThrough,
  withBend,
  curveSteps,
  onCurve,
  textFramePad,
  strokeReach,
  handleSpan,
  straightenReach,
  minTextSize,
  targetPad,
} from "./annotate-geometry";
import type {
  RedactStyle,
  Point,
  Mark,
  LineMark,
  TextMark,
  Box,
  MeasureText,
  HitOptions,
  HandleId,
  Handle,
} from "./annotate-sketch";

function segmentDistance(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  if (squared === 0) return distance(point, a);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared),
  );
  return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

function lineDistance(mark: LineMark, point: Point) {
  if (!mark.bend) return segmentDistance(point, mark.from, mark.to);
  const control = curveControl(mark);
  let nearest = Infinity;
  let previous = mark.from;
  for (let step = 1; step <= curveSteps; step++) {
    const next = onCurve(mark.from, control, mark.to, step / curveSteps);
    nearest = Math.min(nearest, segmentDistance(point, previous, next));
    previous = next;
  }
  return nearest;
}

export function textFrame(mark: TextMark, measure: MeasureText, scale = 1) {
  const area = measure(mark);
  const pad = textFramePad * scale;
  return {
    x: area.x - pad,
    y: area.y - pad,
    width: area.width + 2 * pad,
    height: area.height + 2 * pad,
  };
}

/** Whether `point` picks up `mark`: on its outline, or inside a redaction or text. */
export function markContains(
  mark: Mark,
  point: Point,
  { scale, coarse, measure }: HitOptions,
): boolean {
  if (mark.kind === "pen") return false;
  if (mark.kind === "text") {
    const area = measure(mark);
    return (
      point.x >= area.x &&
      point.x <= area.x + area.width &&
      point.y >= area.y &&
      point.y <= area.y + area.height
    );
  }
  const width = mark.kind === "redact" ? strokeWidth * scale : mark.width;
  const reach = Math.max(
    strokeReach(width, scale, coarse),
    mark.kind === "arrow" ? width * 2 : 0,
  );
  if (isLineMark(mark)) return lineDistance(mark, point) <= reach;
  const area = box(mark.from, mark.to);
  if (mark.kind === "redact")
    return (
      point.x >= area.x - reach &&
      point.x <= area.x + area.width + reach &&
      point.y >= area.y - reach &&
      point.y <= area.y + area.height + reach
    );
  if (mark.kind === "rect") {
    const corners = [
      { x: area.x, y: area.y },
      { x: area.x + area.width, y: area.y },
      { x: area.x + area.width, y: area.y + area.height },
      { x: area.x, y: area.y + area.height },
    ];
    return corners.some(
      (corner, index) =>
        segmentDistance(point, corner, corners[(index + 1) % 4]) <= reach,
    );
  }
  const rx = area.width / 2;
  const ry = area.height / 2;
  const cx = area.x + rx;
  const cy = area.y + ry;
  const steps = 64;
  let nearest = Infinity;
  let previous = { x: cx + rx, y: cy };
  for (let step = 1; step <= steps; step++) {
    const angle = (step / steps) * Math.PI * 2;
    const next = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
    nearest = Math.min(nearest, segmentDistance(point, previous, next));
    previous = next;
  }
  return nearest <= reach;
}

/** The topmost mark under `point` (text only, when asked), passing over `skip`. */
export function markAt(
  marks: Mark[],
  point: Point,
  options: HitOptions & { textOnly?: boolean; skip?: Mark | null },
): Mark | null {
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index];
    if (mark === options.skip) continue;
    if (options.textOnly && mark.kind !== "text") continue;
    if (markContains(mark, point, options)) return mark;
  }
  return null;
}

const resizeCursors: Partial<Record<HandleId, string>> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

/** The handles of a selected mark (none for pen strokes). */
export function markHandles(
  mark: Mark,
  scale: number,
  measure: MeasureText,
): Handle[] {
  const at = (id: HandleId, x: number, y: number): Handle => ({
    id,
    x,
    y,
    cursor: resizeCursors[id] ?? "crosshair",
  });
  if (mark.kind === "pen") return [];
  if (mark.kind === "text") {
    const frame = textFrame(mark, measure, scale);
    const right = frame.x + frame.width;
    const bottom = frame.y + frame.height;
    return [
      at("nw", frame.x, frame.y),
      at("ne", right, frame.y),
      at("se", right, bottom),
      at("sw", frame.x, bottom),
    ];
  }
  if (isLineMark(mark)) {
    const middle = bendHandle(mark);
    const bendable =
      mark.bend !== undefined ||
      distance(mark.from, mark.to) >= handleSpan * scale;
    return [
      at("start", mark.from.x, mark.from.y),
      at("end", mark.to.x, mark.to.y),
      ...(bendable ? [at("bend", middle.x, middle.y)] : []),
    ];
  }
  const area = box(mark.from, mark.to);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const midX = area.x + area.width / 2;
  const midY = area.y + area.height / 2;
  const wide = area.width >= handleSpan * scale;
  const tall = area.height >= handleSpan * scale;
  return [
    at("nw", area.x, area.y),
    ...(wide ? [at("n", midX, area.y)] : []),
    at("ne", right, area.y),
    ...(tall ? [at("e", right, midY)] : []),
    at("se", right, bottom),
    ...(wide ? [at("s", midX, bottom)] : []),
    at("sw", area.x, bottom),
    ...(tall ? [at("w", area.x, midY)] : []),
  ];
}

/** How far from a handle a press still takes it: 4.5–8px (16px by touch), less on small marks. */
export function handleReach(
  mark: Mark,
  { scale, coarse, measure }: HitOptions,
): number {
  if (mark.kind === "pen") return 0;
  let fit: number;
  if (isLineMark(mark)) {
    const bend = markHandles(mark, scale, measure).find(
      (handle) => handle.id === "bend",
    );
    fit = bend
      ? Math.max(distance(bend, mark.from), distance(bend, mark.to)) / 3
      : distance(mark.from, mark.to) / 4;
  } else {
    const area =
      mark.kind === "text"
        ? textFrame(mark, measure, scale)
        : box(mark.from, mark.to);
    const span = handleSpan * scale;
    fit = Math.min(
      Math.min(area.width, area.height) / 4,
      area.width >= span ? area.width / 6 : Infinity,
      area.height >= span ? area.height / 6 : Infinity,
    );
  }
  return Math.max(4.5 * scale, Math.min((coarse ? 16 : 8) * scale, fit));
}

/** The handle of `mark` under `point`; the bend handle wins whenever it is in reach. */
export function handleAt(
  mark: Mark,
  point: Point,
  options: HitOptions,
): Handle | null {
  const reach = handleReach(mark, options);
  let best: Handle | null = null;
  let bestDistance = reach;
  for (const handle of markHandles(mark, options.scale, options.measure)) {
    const away = distance(point, handle);
    if (handle.id === "bend" && away <= reach) return handle;
    if (away < bestDistance || (best === null && away <= bestDistance)) {
      best = handle;
      bestDistance = away;
    }
  }
  return best;
}

/**
 * Shift while drawing or dragging an end: lines and arrows snap to 45° steps,
 * rectangles and ellipses to squares and circles.
 */
export function constrainPoint(
  kind: Mark["kind"],
  anchor: Point,
  point: Point,
  shift: boolean,
): Point {
  if (!shift) return point;
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (kind === "line" || kind === "arrow") {
    const length = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return {
      x: anchor.x + length * Math.cos(angle),
      y: anchor.y + length * Math.sin(angle),
    };
  }
  if (kind === "rect" || kind === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: anchor.x + side * (Math.sign(dx) || 1),
      y: anchor.y + side * (Math.sign(dy) || 1),
    };
  }
  return point;
}

/** Drags one handle of a shape, line or redaction to `point`. */
export function dragHandle(
  mark: Mark,
  handle: HandleId,
  point: Point,
  { shift = false, scale = 1 }: { shift?: boolean; scale?: number } = {},
): Mark {
  if (mark.kind === "pen" || mark.kind === "text") return mark;
  if (isLineMark(mark)) {
    if (handle === "bend") {
      const middle = {
        x: (mark.from.x + mark.to.x) / 2,
        y: (mark.from.y + mark.to.y) / 2,
      };
      if (distance(point, middle) <= straightenReach * scale)
        return mark.bend ? withBend(mark, undefined) : mark;
      return withBend(mark, bendThrough(mark.from, mark.to, point));
    }
    if (handle === "start")
      return {
        ...mark,
        from: constrainPoint(mark.kind, mark.to, point, shift),
      };
    if (handle === "end")
      return {
        ...mark,
        to: constrainPoint(mark.kind, mark.from, point, shift),
      };
    return mark;
  }
  const area = box(mark.from, mark.to);
  const left = area.x;
  const top = area.y;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  switch (handle) {
    case "n":
      return {
        ...mark,
        from: { x: left, y: bottom },
        to: { x: right, y: point.y },
      };
    case "s":
      return {
        ...mark,
        from: { x: left, y: top },
        to: { x: right, y: point.y },
      };
    case "w":
      return {
        ...mark,
        from: { x: right, y: top },
        to: { x: point.x, y: bottom },
      };
    case "e":
      return {
        ...mark,
        from: { x: left, y: top },
        to: { x: point.x, y: bottom },
      };
    case "nw":
    case "ne":
    case "se":
    case "sw": {
      const anchor = {
        x: handle === "nw" || handle === "sw" ? right : left,
        y: handle === "nw" || handle === "ne" ? bottom : top,
      };
      return {
        ...mark,
        from: anchor,
        to: constrainPoint(mark.kind, anchor, point, shift),
      };
    }
    default:
      return mark;
  }
}

/** Resizes text by a corner of its frame; the opposite corner stays put. */
export function resizeText(
  mark: TextMark,
  handle: HandleId,
  point: Point,
  measure: MeasureText,
  scale = 1,
): TextMark {
  if (handle !== "nw" && handle !== "ne" && handle !== "se" && handle !== "sw")
    return mark;
  const area = measure(mark);
  if (area.height <= 0 || mark.size <= 0) return mark;
  const pad = textFramePad * scale;
  const east = handle === "ne" || handle === "se";
  const south = handle === "se" || handle === "sw";
  const anchorX = area.x - pad + (east ? 0 : area.width + 2 * pad);
  const anchorY = area.y - pad + (south ? 0 : area.height + 2 * pad);
  const wantWidth = (point.x - anchorX) * (east ? 1 : -1) - 2 * pad;
  const wantHeight = (point.y - anchorY) * (south ? 1 : -1) - 2 * pad;
  const ratio = Math.max(
    area.width > 0 ? wantWidth / area.width : -Infinity,
    wantHeight / area.height,
  );
  const size = Math.max(
    Math.min(minTextSize * scale, mark.size),
    mark.size * ratio,
  );
  if (Math.abs(size - mark.size) < 1e-6) return mark;
  const sized = { ...mark, size };
  const next = measure(sized);
  return {
    ...sized,
    at: {
      x: east ? anchorX + pad : anchorX - pad - next.width,
      y: south ? anchorY + pad : anchorY - pad - next.height,
    },
  };
}

/** The middle of a mark's extent (a line's includes its bend handle). */
export function markCenter(mark: Mark, measure: MeasureText): Point {
  if (mark.kind === "text") {
    const area = measure(mark);
    return { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  }
  const points =
    mark.kind === "pen"
      ? mark.points
      : isLineMark(mark)
        ? [mark.from, mark.to, bendHandle(mark)]
        : [mark.from, mark.to];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** A mark moves until its middle reaches the picture's edge. */
export function clampMove(
  mark: Mark,
  dx: number,
  dy: number,
  size: { width: number; height: number },
  measure: MeasureText,
) {
  const center = markCenter(mark, measure);
  const clamp = (value: number, low: number, high: number) =>
    Math.min(Math.max(value, Math.min(low, 0)), Math.max(high, 0));
  return {
    dx: clamp(dx, -center.x, size.width - center.x),
    dy: clamp(dy, -center.y, size.height - center.y),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Redacting by text: with Redact, a click without a drag on a word the picture
 * shows covers that word, 2px out, revealed left to right over 200ms (ease-out
 * cubic).
 * -------------------------------------------------------------------------
 */

/** The smallest word box under `point`, in the picture's pixels. */
export function textTargetAt(targets: Box[], point: Point): Box | null {
  let best: Box | null = null;
  for (const target of targets)
    if (
      point.x >= target.x &&
      point.x <= target.x + target.width &&
      point.y >= target.y &&
      point.y <= target.y + target.height &&
      (!best || target.width * target.height < best.width * best.height)
    )
      best = target;
  return best;
}

export function targetRedaction(
  target: Box,
  style: RedactStyle,
  scale = 1,
): Mark {
  const pad = targetPad * scale;
  return {
    kind: "redact",
    style,
    from: { x: target.x - pad, y: target.y - pad },
    to: {
      x: target.x + target.width + pad,
      y: target.y + target.height + pad,
    },
  };
}
