/**
 * Tooltip placements:
 * - "below": centred under the anchor;
 * - "below-before": ending 4px before the anchor's left edge;
 * - "below-end": right edges aligned, for buttons near the window's right edge;
 * - "above": centred over the anchor;
 * - "right": beside the anchor, vertically centred;
 * - "left": the same on the anchor's left (the login page's "Last used").
 */
export type TooltipPlacement =
  | "below"
  | "below-before"
  | "below-end"
  | "above"
  | "above-start"
  | "right"
  | "left";

type Box = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };

/**
 * Gap between the button and its tooltip: the original Tooltip's sideOffset of
 * 4.
 */
export const tooltipGap = 4;
/** Closest a tooltip comes to the window edge. */
export const tooltipMargin = 8;
/**
 * How near the window's edge a tooltip may sit before it flips to the other
 * side of its anchor: the original's collisionPadding of 5, with side and align
 * both "flip".
 */
export const tooltipCollisionPadding = 5;

/**
 * Where a tooltip of `size` goes for an anchor `box`, in window coordinates,
 * `gap` away from it (the chrome buttons' 1.5 by default). A tooltip that
 * would run past the window's edge opens on the anchor's other side when
 * that side has the room, and is kept inside the window either way.
 */
export function tooltipPosition(
  box: Box,
  size: Size,
  view: Size,
  placement: TooltipPlacement,
  gap = tooltipGap,
) {
  const { placement: _side, ...at } = resolve(box, size, view, placement, gap);
  return at;
}

/** The side of the anchor a tooltip opens on after any flip. */
export function tooltipSide(
  box: Box,
  size: Size,
  view: Size,
  placement: TooltipPlacement,
  gap = tooltipGap,
) {
  return resolve(box, size, view, placement, gap).placement;
}

function resolve(
  box: Box,
  size: Size,
  view: Size,
  placement: TooltipPlacement,
  gap: number,
) {
  const pad = tooltipCollisionPadding;
  const flips: Partial<Record<TooltipPlacement, TooltipPlacement>> = {
    above: "below",
    "above-start": "below",
    below: "above",
    "below-before": "above",
    "below-end": "above",
    right: "left",
    left: "right",
  };
  const vertical = placement !== "right" && placement !== "left";
  const away = (at: { left: number; top: number }) =>
    vertical
      ? at.top < pad || at.top + size.height > view.height - pad
      : at.left < pad || at.left + size.width > view.width - pad;
  const first = place(box, size, placement, gap);
  const other = flips[placement];
  if (other && away(first)) {
    const second = place(box, size, other, gap);
    if (!away(second))
      return { ...clamp(second, size, view), placement: other };
  }
  return { ...clamp(first, size, view), placement };
}

function place(box: Box, size: Size, placement: TooltipPlacement, gap: number) {
  let left: number, top: number;
  if (placement === "right") {
    left = box.right + gap + 4;
    top = (box.top + box.bottom) / 2 - size.height / 2;
  } else if (placement === "left") {
    left = box.left - gap - 4 - size.width;
    top = (box.top + box.bottom) / 2 - size.height / 2;
  } else if (placement === "above" || placement === "above-start") {
    top = box.top - gap - size.height;
    left =
      placement === "above-start"
        ? box.left
        : (box.left + box.right) / 2 - size.width / 2;
  } else {
    top = box.bottom + gap;
    left =
      placement === "below-before"
        ? box.left - 4 - size.width
        : placement === "below-end"
          ? box.right - size.width
          : (box.left + box.right) / 2 - size.width / 2;
  }
  return { left, top };
}

function clamp(at: { left: number; top: number }, size: Size, view: Size) {
  const keep = (value: number, extent: number, available: number) =>
    Math.max(
      tooltipMargin,
      Math.min(value, available - tooltipMargin - extent),
    );
  return {
    left: keep(at.left, size.width, view.width),
    top: keep(at.top, size.height, view.height),
  };
}

/**
 * The point a tooltip at `at` grows from: the middle of the anchor's side
 * of it, as the original's popups take theirs from the anchor
 * (--transform-origin), so it appears to come out of the button.
 */
export function tooltipOrigin(
  box: Box,
  at: { left: number; top: number },
  size: Size,
  placement: TooltipPlacement,
) {
  const within = (value: number, extent: number) =>
    Math.max(0, Math.min(extent, value));
  if (placement === "right")
    return `0 ${within((box.top + box.bottom) / 2 - at.top, size.height)}px`;
  if (placement === "left")
    return `${size.width}px ${within((box.top + box.bottom) / 2 - at.top, size.height)}px`;
  const x = within((box.left + box.right) / 2 - at.left, size.width);
  // From the side the tooltip ended up on (it flips off a button at the
  // window's edge, tooltipPosition), not the side it was asked for.
  const above =
    at.top + size.height <= box.top ||
    (at.top < box.bottom &&
      (placement === "above" || placement === "above-start"));
  return `${x}px ${above ? "100%" : "0"}`;
}
