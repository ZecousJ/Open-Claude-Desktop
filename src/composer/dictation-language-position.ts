/**
 * Stable searchable submenu placement. Retain the largest measured height until
 * close; a flipped end-aligned popup keeps its bottom edge when filtering
 * removes rows.
 */
export function dictationLanguagePosition({
  trigger,
  width,
  contentHeight,
  viewport,
  previous,
}: {
  trigger: { left: number; right: number; top: number; bottom: number };
  width: number;
  contentHeight: number;
  viewport: { width: number; height: number };
  previous: { heldHeight: number; alignEnd: boolean | undefined };
}) {
  const heldHeight = Math.max(previous.heldHeight, contentHeight);
  const height = Math.min(heldHeight, Math.max(0, viewport.height - 10));
  const alignEnd =
    previous.alignEnd ?? trigger.top - 4 + height > viewport.height - 5;
  const left =
    trigger.right + 6 + width <= viewport.width - 5
      ? trigger.right + 6
      : trigger.left - width - 6;
  return {
    left: Math.max(5, Math.min(left, viewport.width - width - 5)),
    top: Math.max(
      5,
      Math.min(
        alignEnd ? trigger.bottom - height + 4 : trigger.top - 4,
        viewport.height - height - 5,
      ),
    ),
    height,
    heldHeight,
    alignEnd,
  };
}
