/**
 * The words a picture shows, so Redact can cover one with a single click.
 * Brightness edges are grouped into pieces; pieces too tall, hollow outlines
 * and long straight runs (frames, rules) are dropped; what is left is closed
 * across gaps of up to 3 pixels into word boxes, kept when they look like text:
 * 6–64 pixels high, dense enough in edges and crossing them often enough along
 * each row. Boxes are in the picture's own pixels.
 */
import type { Box } from "./annotate-sketch";

/** Edge strength (sum of the two brightness differences) that counts as an edge. */
const edgeStep = 28;
/** Straight runs longer than this are frames or rules, not letters. */
const longRun = 40;
/** Letters closer than this belong to one word. */
const letterGap = 3;
/** Pictures over 8 megapixels are read at half size. */
const largest = 8e6;

/** Brightness of each pixel, transparent parts read over white. */
function brightness(rgba: Uint8ClampedArray, count: number) {
  const out = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const base = index * 4;
    const alpha = rgba[base + 3] / 255;
    const over = (value: number) => value * alpha + 255 * (1 - alpha);
    out[index] =
      (over(rgba[base]) * 299 +
        over(rgba[base + 1]) * 587 +
        over(rgba[base + 2]) * 114) /
      1000;
  }
  return out;
}

function edgeMask(light: Uint8Array, width: number, height: number) {
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const step =
        Math.abs(light[at + 1] - light[at - 1]) +
        Math.abs(light[at + width] - light[at - width]);
      if (step >= edgeStep) mask[at] = 1;
    }
  return mask;
}

interface Piece {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pixels of the piece. */
  size: number;
  /** Of those, pixels on an edge of the original mask. */
  edges: number;
}

/** Eight-connected pieces of `mask`, with each pixel's piece number (from 1). */
function pieces(
  mask: Uint8Array,
  edges: Uint8Array,
  width: number,
  height: number,
) {
  const label = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const found: Piece[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = found.length + 1;
    label[start] = id;
    let top = 0;
    stack[top++] = start;
    const piece = { x: width, y: height, w: 0, h: 0, size: 0, edges: 0 };
    let right = 0;
    let bottom = 0;
    while (top > 0) {
      const at = stack[--top];
      const y = (at / width) | 0;
      const x = at - y * width;
      piece.size++;
      piece.edges += edges[at];
      piece.x = Math.min(piece.x, x);
      piece.y = Math.min(piece.y, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const next = ny * width + nx;
          if (mask[next] && !label[next]) {
            label[next] = id;
            stack[top++] = next;
          }
        }
      }
    }
    piece.w = right - piece.x + 1;
    piece.h = bottom - piece.y + 1;
    found.push(piece);
  }
  return { found, label };
}

/** Drops pieces taller than a line of text and big hollow outlines. */
function dropShapes(mask: Uint8Array, width: number, height: number) {
  const { found, label } = pieces(mask, mask, width, height);
  const drop = found.map(
    (piece) =>
      piece.h > 64 ||
      ((piece.w >= longRun || piece.h >= longRun) &&
        piece.size / (piece.w * piece.h) < 0.12),
  );
  for (let at = 0; at < mask.length; at++)
    if (mask[at] && drop[label[at] - 1]) mask[at] = 0;
}

/** Clears straight runs longer than `longRun`, across and down. */
function dropRuns(mask: Uint8Array, width: number, height: number) {
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && mask[y * width + x];
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        if (x - start > longRun) mask.fill(0, y * width + start, y * width + x);
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const on = y < height && mask[y * width + x];
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        if (y - start > longRun)
          for (let fill = start; fill < y; fill++) mask[fill * width + x] = 0;
        start = -1;
      }
    }
  }
}

/** Joins pixels across gaps of up to `gap` along each row, one row up and down too. */
function closeGaps(
  mask: Uint8Array,
  width: number,
  height: number,
  gap: number,
) {
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (last >= 0 && x - last - 1 <= gap)
        across.fill(1, row + last + 1, row + x);
      across[row + x] = 1;
      last = x;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let at = 0; at < mask.length; at++)
    if (
      across[at] ||
      (at >= width && across[at - width]) ||
      (at + width < mask.length && across[at + width])
    )
      out[at] = 1;
  return out;
}

/** How often each row of the box crosses the edge mask, on average. */
function crossings(mask: Uint8Array, width: number, piece: Piece) {
  let count = 0;
  for (let y = piece.y; y < piece.y + piece.h; y++) {
    let previous = 0;
    for (let x = piece.x; x < piece.x + piece.w; x++) {
      const value = mask[y * width + x];
      if (value !== previous) {
        count++;
        previous = value;
      }
    }
  }
  return count / piece.h;
}

function looksLikeWord(mask: Uint8Array, width: number, piece: Piece) {
  const area = piece.w * piece.h;
  if (
    piece.h < 6 ||
    piece.h > 64 ||
    piece.w < 4 ||
    piece.w > piece.h * 60 ||
    piece.size / area < 0.3 ||
    piece.edges / area < 0.12 ||
    piece.edges < 16 ||
    (piece.h <= 10 && piece.w <= 14) ||
    (piece.w < 8 && piece.h > 2 * piece.w)
  )
    return false;
  const crossed = crossings(mask, width, piece);
  if (piece.h > 28 && crossed < 4) return false;
  return crossed >= Math.max(2, piece.w / (piece.h * 2.2));
}

/** Word boxes in an RGBA picture of `width` × `height`. */
export function findTextBoxes(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Box[] {
  if (width < 3 || height < 3 || rgba.length < width * height * 4) return [];
  const mask = edgeMask(brightness(rgba, width * height), width, height);
  dropShapes(mask, width, height);
  dropRuns(mask, width, height);
  const { found } = pieces(
    closeGaps(mask, width, height, letterGap),
    mask,
    width,
    height,
  );
  return found
    .filter((piece) => looksLikeWord(mask, width, piece))
    .map((piece) => ({
      x: piece.x,
      y: piece.y,
      width: piece.w,
      height: piece.h,
    }));
}

/** Reads the picture at `src` and finds its words; null when it can't be read. */
export async function detectTextTargets(src: string): Promise<Box[] | null> {
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    const fullWidth = image.naturalWidth;
    const fullHeight = image.naturalHeight;
    const shrink = fullWidth * fullHeight > largest ? 2 : 1;
    const width = Math.round(fullWidth / shrink);
    const height = Math.round(fullHeight / shrink);
    if (width * height > largest) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const boxes = findTextBoxes(
      ctx.getImageData(0, 0, width, height).data,
      width,
      height,
    );
    const ratio = fullWidth / width;
    return ratio === 1
      ? boxes
      : boxes.map((each) => ({
          x: each.x * ratio,
          y: each.y * ratio,
          width: each.width * ratio,
          height: each.height * ratio,
        }));
  } catch {
    return null;
  }
}
