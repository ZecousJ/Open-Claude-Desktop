/*
 * The image lightbox's state, kept outside React so any image in the app
 * can open it with one call (openLightbox in Lightbox.tsx). Pure, so the
 * carousel arithmetic is tested on its own.
 */

/** One picture the lightbox can show. */
export interface LightboxImage {
  src: string;
  alt?: string;
  /** Shown at the bottom left over a fade (the live viewer's attribution slot). */
  caption?: string;
  /**
   * The thumbnail on the page it opened from. The picture grows out of it
   * and shrinks back into it while it is still on screen.
   */
  origin?: HTMLElement | null;
}

export interface LightboxState {
  images: LightboxImage[];
  index: number;
  /** Fading out (the close without a thumbnail to shrink into). */
  closing?: boolean;
}

/** A slide is 75vw wide and 32px from the next. */
export const SLIDE_VW = 75;
export const SLIDE_GAP_PX = 32;

/**
 * The carousel track's offset with slide `index` centred: the first slide
 * starts 12.5vw in, and each step moves one slide and one gap left.
 */
export function trackOffset(index: number) {
  return `translateX(calc(${(100 - SLIDE_VW) / 2}vw - ${index * SLIDE_VW}vw - ${index * SLIDE_GAP_PX}px))`;
}

/** `index` kept inside the list (the carousel does not wrap). */
export function clampIndex(index: number, count: number) {
  return Math.max(0, Math.min(count - 1, index));
}

/** The slide a key moves to, or undefined for a key the carousel ignores. */
export function keyTarget(key: string, index: number, count: number) {
  if (key === "ArrowLeft") return clampIndex(index - 1, count);
  if (key === "ArrowRight") return clampIndex(index + 1, count);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/** "{current} of {total}", the counter between the arrows. */
export function counterLabel(index: number, count: number) {
  return `${index + 1} of ${count}`;
}

/**
 * Where a picture drawn with object-fit: contain sits inside its box, as
 * percentages of the box (top right bottom left), so the morph starts from
 * the picture itself rather than its letterboxed frame. Undefined when it
 * fills the box.
 */
export function containedInset(
  box: { width: number; height: number },
  natural: { width: number; height: number },
) {
  if (!(box.width > 0 && box.height > 0)) return undefined;
  if (!(natural.width > 0 && natural.height > 0)) return undefined;
  const scale = Math.min(
    box.width / natural.width,
    box.height / natural.height,
  );
  const x = (box.width - natural.width * scale) / 2;
  const y = (box.height - natural.height * scale) / 2;
  if (x < 0.5 && y < 0.5) return undefined;
  const percent = (value: number, of: number) =>
    `${Number(((100 * value) / of).toFixed(3))}%`;
  return [
    percent(y, box.height),
    percent(x, box.width),
    percent(y, box.height),
    percent(x, box.width),
  ].join(" ");
}

let state: LightboxState | undefined;
const listeners = new Set<() => void>();

export function lightboxState() {
  return state;
}

export function setLightboxState(next: LightboxState | undefined) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeLightbox(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/*
 * Zoom: a click zooms the picture around the pointer to its natural size (at
 * least 2×), ctrl + wheel zooms by exp(−deltaY × 0.01) up to that size and lets
 * go below 1.05×, a drag of 4px or more pans, and the wheel pans while zoomed.
 * How far it may pan grows with the zoom, so a picture just past fitting cannot
 * be dragged away.
 */
export const ZOOM_MIN_MAX = 2;
export const ZOOM_DRAG_SLOP = 4;
export const ZOOM_WHEEL_LINE = 16;
export const ZOOM_WHEEL_RATE = 0.01;
export const ZOOM_RELEASE_BELOW = 1.05;
export const ZOOM_WHEEL_FIRST = 1.25;
const PAN_SLACK = 0.7;

/** The fitted picture and the stage it sits in, measured once per zoom. */
export interface ZoomFrame {
  fitWidth: number;
  fitHeight: number;
  fitCenterX: number;
  fitCenterY: number;
  maxScale: number;
  viewportWidth: number;
  viewportHeight: number;
}
export interface Zoom extends ZoomFrame {
  scale: number;
  tx: number;
  ty: number;
  /** Where the pan would be without its limits, so zooming back out returns there. */
  idealTx: number;
  idealTy: number;
  maxTx: number;
  maxTy: number;
}
const UNZOOMED = { scale: 1, idealTx: 0, idealTy: 0 };

export const clampPan = (value: number, limit: number) =>
  Math.min(limit, Math.max(-limit, value));

function overhang(size: number, viewport: number) {
  const slack = Math.min(size, viewport * PAN_SLACK);
  return Math.max(0, (size + viewport) / 2 - slack);
}
function panLimit(fit: number, viewport: number, scale: number) {
  const ease = Math.min(1, Math.max(0, (scale - ZOOM_RELEASE_BELOW) / 0.95));
  return overhang(fit * scale, viewport) * ease;
}

/** The frame for a picture box and its stage, or null while either is unsized. */
export function zoomFrame(
  picture: { left: number; top: number; width: number; height: number },
  naturalWidth: number,
  stage: { width: number; height: number } | undefined,
): ZoomFrame | null {
  if (!stage || picture.width === 0 || picture.height === 0) return null;
  return {
    fitWidth: picture.width,
    fitHeight: picture.height,
    fitCenterX: picture.left + picture.width / 2,
    fitCenterY: picture.top + picture.height / 2,
    maxScale: Math.max(naturalWidth / picture.width, ZOOM_MIN_MAX),
    viewportWidth: stage.width,
    viewportHeight: stage.height,
  };
}

/** `from` zoomed to `scale`, keeping the point under the pointer (if any) still. */
export function zoomTo(
  frame: ZoomFrame,
  from: { scale: number; idealTx: number; idealTy: number },
  scale: number,
  pointer?: { clientX: number; clientY: number } | null,
): Zoom {
  const maxTx = panLimit(frame.fitWidth, frame.viewportWidth, scale);
  const maxTy = panLimit(frame.fitHeight, frame.viewportHeight, scale);
  const px = pointer ? pointer.clientX - frame.fitCenterX : 0;
  const py = pointer ? pointer.clientY - frame.fitCenterY : 0;
  const ratio = scale / from.scale;
  const idealTx = px - (px - from.idealTx) * ratio;
  const idealTy = py - (py - from.idealTy) * ratio;
  const tx = clampPan(idealTx, maxTx);
  const ty = clampPan(idealTy, maxTy);
  const wasX = panLimit(frame.fitWidth, frame.viewportWidth, from.scale);
  const wasY = panLimit(frame.fitHeight, frame.viewportHeight, from.scale);
  return {
    ...frame,
    scale,
    idealTx: maxTx < wasX ? tx : idealTx,
    idealTy: maxTy < wasY ? ty : idealTy,
    tx,
    ty,
    maxTx,
    maxTy,
  };
}

/** A click's zoom: all the way in, around the pointer, kept on screen. */
export function clickZoom(
  frame: ZoomFrame,
  pointer?: { clientX: number; clientY: number } | null,
): Zoom {
  const zoom = zoomTo(frame, UNZOOMED, frame.maxScale, pointer);
  const limitX = Math.max(
    0,
    (frame.fitWidth * frame.maxScale - frame.viewportWidth) / 2,
  );
  const limitY = Math.max(
    0,
    (frame.fitHeight * frame.maxScale - frame.viewportHeight) / 2,
  );
  const tx = clampPan(zoom.tx, limitX);
  const ty = clampPan(zoom.ty, limitY);
  return { ...zoom, tx, ty, idealTx: tx, idealTy: ty };
}

/** A ctrl + wheel step; null when it lets go of the zoom. */
export function wheelZoom(
  current: Zoom | null,
  frame: ZoomFrame | null,
  deltaY: number,
  pointer: { clientX: number; clientY: number },
): Zoom | null {
  const base = current ?? frame;
  if (!base) return current;
  const from = current ?? UNZOOMED;
  const factor = Math.exp(-deltaY * ZOOM_WHEEL_RATE);
  const next = Math.min(Math.max(from.scale * factor, 1), base.maxScale);
  if (!current && next === 1) return current;
  const scale = current
    ? next
    : Math.min(Math.max(next, ZOOM_WHEEL_FIRST), base.maxScale);
  if (factor < 1 && scale <= ZOOM_RELEASE_BELOW) return null;
  if (current && scale === current.scale) return current;
  return zoomTo(base, from, scale, pointer);
}

export const zoomTransform = (zoom: Pick<Zoom, "tx" | "ty" | "scale">) =>
  `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
