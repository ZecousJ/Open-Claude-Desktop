/**
 * The marks of Annotate and how they are drawn: Pen, Line, Arrow, Rectangle,
 * Ellipse, Text and Redact, in one of five ink colours; redactions are solid
 * black or carry a mosaic or noise texture. Strokes are 4 pixels wide and text
 * 16 pixels high on the shown picture, so the marks are kept in the picture's
 * own pixels and scaled by how much smaller the picture is shown.
 */
import { textFrame, markHandles } from "./annotate-hit";
import {
  strokeWidth,
  box,
  distance,
  curveControl,
  curveSteps,
  onCurve,
} from "./annotate-geometry";

export type SketchTool =
  "pen" | "line" | "arrow" | "rect" | "ellipse" | "text" | "redact";

export const sketchTools: SketchTool[] = [
  "pen",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "redact",
];

export const toolLabels: Record<SketchTool, string> = {
  pen: "Pen",
  line: "Line",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  redact: "Redact",
};

export type RedactStyle = "solid" | "mosaic" | "noise";
export const redactStyles: RedactStyle[] = ["solid", "mosaic", "noise"];
export const redactStyleLabels: Record<RedactStyle, string> = {
  solid: "Solid",
  mosaic: "Mosaic",
  noise: "Noise",
};

/** The ink colours and their names. */
export const inkColors: { value: string; label: string }[] = [
  { value: "#E03131", label: "Red" },
  { value: "#1971C2", label: "Blue" },
  { value: "#2F9E44", label: "Green" },
  { value: "#1F1E1D", label: "Black" },
  { value: "#FFFFFF", label: "White" },
];
export const textSize = 16;
const redactFill = "#000000";
const redactRadius = 4;
/** Texture cells: mosaic 12px squares in greys 56–200, noise 2px in 16–240, on a 96px tile. */
const textureCell: Record<Exclude<RedactStyle, "solid">, number> = {
  mosaic: 12,
  noise: 2,
};
const textureTile = 96;
export const textFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export interface Point {
  x: number;
  y: number;
}

/**
 * Where a bent line's middle handle sits: `u` along the line from its start and
 * `v` across it, both in line lengths.
 */
export interface Bend {
  u: number;
  v: number;
}

export type Mark =
  | { kind: "pen"; color: string; width: number; points: Point[] }
  | {
      kind: "line" | "arrow" | "rect" | "ellipse";
      color: string;
      width: number;
      from: Point;
      to: Point;
      /** A bent line or arrow (only those two ever carry one). */
      bend?: Bend;
    }
  | { kind: "redact"; style: RedactStyle; from: Point; to: Point }
  | {
      kind: "text";
      color: string;
      size: number;
      at: Point;
      text: string;
    };

/** A grey for one texture cell (`t` in 0…1). */
export function textureGrey(style: "mosaic" | "noise", t: number) {
  const [low, high] = style === "mosaic" ? [56, 200] : [16, 240];
  const value = Math.round(low + t * (high - low))
    .toString(16)
    .padStart(2, "0");
  return `#${value}${value}${value}`;
}

/** A mark too small to keep: a click without a drag (redactions under 4px). */
export function isEmptyMark(mark: Mark): boolean {
  if (mark.kind === "pen") return mark.points.length === 0;
  if (mark.kind === "text") return mark.text.trim() === "";
  const flatX = mark.from.x === mark.to.x;
  const flatY = mark.from.y === mark.to.y;
  if (mark.kind !== "redact") return flatX && flatY;
  return (
    flatX ||
    flatY ||
    Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) < 4
  );
}

/** The arrow's head: its tip and the two back corners. */
export function arrowHead(from: Point, to: Point, width: number) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const size = Math.min(width * 4, length);
  const dx = length ? (to.x - from.x) / length : 0;
  const dy = length ? (to.y - from.y) / length : 0;
  return {
    size,
    /** Where the shaft stops, under the head. */
    shaftEnd: {
      x: to.x - dx * Math.min(size * 0.7, length),
      y: to.y - dy * Math.min(size * 0.7, length),
    },
    corners: [
      {
        x: to.x - size * dx + (size / 2) * dy,
        y: to.y - size * dy - (size / 2) * dx,
      },
      {
        x: to.x - size * dx - (size / 2) * dy,
        y: to.y - size * dy + (size / 2) * dx,
      },
    ] as [Point, Point],
  };
}

const tiles = new Map<string, HTMLCanvasElement>();
function texture(ctx: CanvasRenderingContext2D, style: "mosaic" | "noise") {
  let tile = tiles.get(style);
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = tile.height = textureTile;
    const paint = tile.getContext("2d");
    if (!paint) return null;
    const cell = textureCell[style];
    for (let y = 0; y < textureTile; y += cell)
      for (let x = 0; x < textureTile; x += cell) {
        paint.fillStyle = textureGrey(style, Math.random());
        paint.fillRect(x, y, cell, cell);
      }
    tiles.set(style, tile);
  }
  return ctx.createPattern(tile, "repeat");
}

/** Draws one mark; `scale` is the picture's pixels per shown pixel. */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  mark: Mark,
  scale = 1,
  /** A redaction still being revealed, left to right (0…1). */
  progress = 1,
) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (mark.kind === "redact") {
    const area = box(mark.from, mark.to);
    const pad = strokeWidth * scale * (1 - Math.SQRT1_2);
    if (progress < 1) {
      ctx.beginPath();
      ctx.rect(
        area.x - pad,
        area.y - pad,
        (area.width + 2 * pad) * Math.max(0, progress),
        area.height + 2 * pad,
      );
      ctx.clip();
    }
    ctx.beginPath();
    ctx.roundRect(
      area.x - pad,
      area.y - pad,
      area.width + 2 * pad,
      area.height + 2 * pad,
      redactRadius * scale,
    );
    ctx.fillStyle = redactFill;
    ctx.fill();
    const pattern = mark.style === "solid" ? null : texture(ctx, mark.style);
    if (pattern) {
      pattern.setTransform?.(new DOMMatrix().scale(scale));
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = pattern;
      ctx.fill();
    }
    ctx.restore();
    return;
  }
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  if (mark.kind === "text") {
    ctx.font = `${mark.size}px ${textFont}`;
    ctx.textBaseline = "top";
    mark.text
      .split("\n")
      .forEach((line, index) =>
        ctx.fillText(line, mark.at.x, mark.at.y + index * mark.size * 1.2),
      );
    ctx.restore();
    return;
  }
  ctx.lineWidth = mark.width;
  if (mark.kind === "pen") {
    const [first, ...rest] = mark.points;
    if (first && rest.length === 0) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (first) {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const point of rest) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  } else if (mark.kind === "line") {
    ctx.beginPath();
    ctx.moveTo(mark.from.x, mark.from.y);
    if (mark.bend) {
      const control = curveControl(mark as LineMark);
      ctx.quadraticCurveTo(control.x, control.y, mark.to.x, mark.to.y);
    } else ctx.lineTo(mark.to.x, mark.to.y);
    ctx.stroke();
  } else if (mark.kind === "arrow") {
    const head = mark.bend
      ? bentArrowHead(mark as LineMark)
      : { ...arrowHead(mark.from, mark.to, mark.width), shaftControl: null };
    ctx.beginPath();
    ctx.moveTo(mark.from.x, mark.from.y);
    if (head.shaftControl)
      ctx.quadraticCurveTo(
        head.shaftControl.x,
        head.shaftControl.y,
        head.shaftEnd.x,
        head.shaftEnd.y,
      );
    else ctx.lineTo(head.shaftEnd.x, head.shaftEnd.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mark.to.x, mark.to.y);
    ctx.lineTo(head.corners[0].x, head.corners[0].y);
    ctx.lineTo(head.corners[1].x, head.corners[1].y);
    ctx.closePath();
    ctx.fill();
  } else if (mark.kind === "rect") {
    const area = box(mark.from, mark.to);
    ctx.strokeRect(area.x, area.y, area.width, area.height);
  } else {
    const area = box(mark.from, mark.to);
    ctx.beginPath();
    ctx.ellipse(
      area.x + area.width / 2,
      area.y + area.height / 2,
      area.width / 2,
      area.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/** Undo, Redo and Clear all. */
export interface SketchHistory {
  past: Mark[][];
  present: Mark[];
  future: Mark[][];
}

export const emptyHistory: SketchHistory = {
  past: [],
  present: [],
  future: [],
};

/** The history keeps the last 100 steps. */
export const historyLimit = 100;

export function commit(history: SketchHistory, marks: Mark[]): SketchHistory {
  return {
    past: [...history.past, history.present].slice(-historyLimit),
    present: marks,
    future: [],
  };
}

export const addMark = (history: SketchHistory, mark: Mark) =>
  isEmptyMark(mark) ? history : commit(history, [...history.present, mark]);

export const clearAll = (history: SketchHistory) =>
  history.present.length ? commit(history, []) : history;

export function undo(history: SketchHistory): SketchHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: SketchHistory): SketchHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Selecting, moving, resizing and bending marks. The original measures its
 * reaches in shown pixels; here every such length is multiplied by `scale`, the
 * picture's pixels per shown pixel, since the marks keep the picture's own
 * pixels.
 * -------------------------------------------------------------------------
 */

/** The tools plus Select, which a tool falls back to once a shape is done. */
export type EditorTool = SketchTool | "select";

export type ShapeMark = Extract<Mark, { from: Point; color: string }>;
export type LineMark = ShapeMark & { kind: "line" | "arrow" };
export type TextMark = Extract<Mark, { kind: "text" }>;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Measures a text mark in the picture's pixels. */
export type MeasureText = (mark: TextMark) => Box;

/** Pen strokes can't be picked up. */
export const isSelectable = (mark: Mark) => mark.kind !== "pen";

/** A line's length; a bent one's is taken a third of the way to its control polygon. */
function lineLength(mark: LineMark) {
  const chord = distance(mark.from, mark.to);
  if (!mark.bend) return chord;
  const control = curveControl(mark);
  const polygon = distance(mark.from, control) + distance(control, mark.to);
  return (2 * chord + polygon) / 3;
}

/** The point on the line `back` (straight-line) from its end, and its curve parameter. */
function pointBackFromEnd(mark: LineMark, back: number) {
  if (!mark.bend) {
    const length = distance(mark.from, mark.to);
    const t = length === 0 ? 0 : Math.max(0, 1 - back / length);
    return {
      t,
      x: mark.from.x + (mark.to.x - mark.from.x) * t,
      y: mark.from.y + (mark.to.y - mark.from.y) * t,
    };
  }
  const control = curveControl(mark);
  const farEnough = (t: number) =>
    distance(onCurve(mark.from, control, mark.to, t), mark.to) >= back;
  let low = -1;
  let high = 1;
  for (let step = curveSteps - 1; step >= 0; step--)
    if (farEnough(step / curveSteps)) {
      low = step / curveSteps;
      high = (step + 1) / curveSteps;
      break;
    }
  if (low < 0) return { t: 0, ...mark.from };
  for (let round = 0; round < 12; round++) {
    const middle = (low + high) / 2;
    if (farEnough(middle)) low = middle;
    else high = middle;
  }
  return { t: low, ...onCurve(mark.from, control, mark.to, low) };
}

/**
 * A bent arrow's head: like `arrowHead`, but the shaft follows the curve
 * (`shaftControl` is the control point of the curve up to `shaftEnd`) and
 * the head points along the curve's last stretch.
 */
export function bentArrowHead(mark: LineMark) {
  const length = lineLength(mark);
  const size = Math.min(mark.width * 4, length);
  const end = pointBackFromEnd(mark, Math.min(size * 0.7, length));
  let dx = mark.to.x - end.x;
  let dy = mark.to.y - end.y;
  if (dx === 0 && dy === 0) {
    dx = mark.to.x - mark.from.x;
    dy = mark.to.y - mark.from.y;
  }
  const norm = Math.hypot(dx, dy);
  const ux = norm ? dx / norm : 1;
  const uy = norm ? dy / norm : 0;
  const control = curveControl(mark);
  return {
    size,
    shaftEnd: { x: end.x, y: end.y },
    shaftControl: mark.bend
      ? {
          x: mark.from.x + (control.x - mark.from.x) * end.t,
          y: mark.from.y + (control.y - mark.from.y) * end.t,
        }
      : null,
    corners: [
      {
        x: mark.to.x - size * ux + (size / 2) * uy,
        y: mark.to.y - size * uy - (size / 2) * ux,
      },
      {
        x: mark.to.x - size * ux - (size / 2) * uy,
        y: mark.to.y - size * uy + (size / 2) * ux,
      },
    ] as [Point, Point],
  };
}

/** A measurer for text marks, remembering each mark's box. */
export function textMeasurer(
  ctx: CanvasRenderingContext2D | null,
): MeasureText {
  const known = new WeakMap<TextMark, Box>();
  return (mark) => {
    const cached = known.get(mark);
    if (cached) return cached;
    const lines = mark.text.split("\n");
    let width = 0;
    if (ctx) {
      ctx.save();
      ctx.font = `${mark.size}px ${textFont}`;
      for (const line of lines)
        width = Math.max(width, ctx.measureText(line).width);
      ctx.restore();
    } else
      width = Math.max(...lines.map((line) => line.length)) * mark.size * 0.6;
    const measured = {
      x: mark.at.x,
      y: mark.at.y,
      width,
      height: lines.length * mark.size * 1.2,
    };
    known.set(mark, measured);
    return measured;
  };
}

export interface HitOptions {
  scale: number;
  /** A touch: reaches are wider. */
  coarse?: boolean;
  measure: MeasureText;
}

export type HandleId =
  "start" | "end" | "bend" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
  cursor: string;
}

export function moveMark(mark: Mark, dx: number, dy: number): Mark {
  const shift = (point: Point) => ({ x: point.x + dx, y: point.y + dy });
  if (mark.kind === "pen") return { ...mark, points: mark.points.map(shift) };
  if (mark.kind === "text") return { ...mark, at: shift(mark.at) };
  return { ...mark, from: shift(mark.from), to: shift(mark.to) };
}

/** Pointer travel before a press on a mark becomes a move: 3px, 10px by touch. */
export const moveThreshold = (coarse: boolean) => (coarse ? 10 : 3);
/** Travel before a drawing hides the toolbar: 4px, 10px by touch. */
export const gestureThreshold = (coarse: boolean) => (coarse ? 10 : 4);

export const replaceMark = (history: SketchHistory, old: Mark, next: Mark) =>
  old === next
    ? history
    : commit(
        history,
        history.present.map((mark) => (mark === old ? next : mark)),
      );

export const removeMark = (history: SketchHistory, mark: Mark) =>
  history.present.includes(mark)
    ? commit(
        history,
        history.present.filter((each) => each !== mark),
      )
    : history;

/** Handles in the accent fill ringed in white; the bend handle green. */
export const selectionColors = {
  accent: "#2a78d6",
  onAccent: "#ffffff",
  bend: "#009300",
};

/** Draws the selection: a dashed frame around text, then the handles. */
export function drawSelection(
  ctx: CanvasRenderingContext2D,
  mark: Mark,
  scale: number,
  measure: MeasureText,
) {
  ctx.save();
  if (mark.kind === "text") {
    const frame = textFrame(mark, measure, scale);
    ctx.strokeStyle = selectionColors.accent;
    ctx.lineWidth = 1.5 * scale;
    ctx.setLineDash([5 * scale, 4 * scale]);
    ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = selectionColors.onAccent;
  ctx.lineWidth = scale;
  for (const handle of markHandles(mark, scale, measure)) {
    const bend = handle.id === "bend";
    ctx.fillStyle = bend ? selectionColors.bend : selectionColors.accent;
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, (bend ? 3 : 3.5) * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** `--dur-base`, 200ms. */
export const revealDuration = 200;
export function revealProgress(elapsed: number) {
  const t = Math.min(1, Math.max(0, elapsed / revealDuration));
  return 1 - (1 - t) ** 3;
}
