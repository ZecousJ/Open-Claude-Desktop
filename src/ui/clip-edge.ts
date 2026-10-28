/**
 * The right edge a popup inside `element` is cut at: the window's, or the
 * nearest ancestor's that clips its overflow (the chat column, narrowed by
 * the side panel). Submenus that would cross it open to the left instead.
 */
export function clipRight(element: Element | null | undefined): number {
  let edge = window.innerWidth;
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflow === "hidden")
      edge = Math.min(edge, node.getBoundingClientRect().right);
  }
  return edge;
}

/** The left edge a popup inside `element` is cut at (as clipRight). */
export function clipLeft(element: Element | null | undefined): number {
  let edge = 0;
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflow === "hidden")
      edge = Math.max(edge, node.getBoundingClientRect().left);
  }
  return edge;
}

/**
 * Moves a popup sideways so it stays `margin` px inside the window: on a
 * phone a menu anchored at a button's edge can be wider than the room on
 * that side. Returns the shift in px (0 when it fits).
 */
export function keepInWindow(
  element: HTMLElement | null | undefined,
  margin = 8,
): number {
  if (!element) return 0;
  element.style.translate = "";
  const rect = element.getBoundingClientRect();
  const room = window.innerWidth - margin;
  const dx =
    rect.left < margin
      ? margin - rect.left
      : rect.right > room
        ? Math.max(margin - rect.left, room - rect.right)
        : 0;
  if (dx) element.style.translate = `${dx}px 0`;
  return dx;
}

/**
 * Lifts a positioned popup out of the boxes that clip it (the chat column
 * clips its overflow, so a submenu turned to the left would be cut at the
 * sidebar): it keeps the place it was laid out in but is drawn fixed to
 * the window, over the sidebar, as the original's submenus are. A
 * transformed ancestor would move a fixed box's origin; the second
 * measurement corrects for that. `release` puts it back.
 */
export function pinToWindow(element: HTMLElement) {
  release(element);
  const rect = element.getBoundingClientRect();
  if (clipLeft(element) <= rect.left && clipRight(element) >= rect.right)
    return;
  const set = (left: number, top: number) =>
    Object.assign(element.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      right: "auto",
      bottom: "auto",
      zIndex: "60",
    });
  set(rect.left, rect.top);
  const moved = element.getBoundingClientRect();
  set(rect.left - (moved.left - rect.left), rect.top - (moved.top - rect.top));
}

export function release(element: HTMLElement) {
  for (const key of ["position", "left", "top", "right", "bottom", "zIndex"])
    element.style.removeProperty(
      key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    );
}
