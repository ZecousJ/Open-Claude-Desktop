/**
 * Dragging a rail card as the live rail's sortable list does: the card follows
 * the pointer on a page fill above the others, the card whose middle is nearest
 * the dragged card's middle is where it lands, and the cards between slide over
 * by the dragged card's height and the gap to open its place.
 */
export interface SlotBox {
  top: number;
  height: number;
}

export function railDragFrame(boxes: SlotBox[], from: number, dy: number) {
  const dragged = boxes[from];
  if (!dragged) return { target: from, shifts: boxes.map(() => 0) };
  const middle = dragged.top + dragged.height / 2 + dy;
  let target = from;
  let nearest = Infinity;
  boxes.forEach((box, index) => {
    const distance = Math.abs(box.top + box.height / 2 - middle);
    if (distance < nearest) {
      nearest = distance;
      target = index;
    }
  });
  const next = boxes[from + 1] ?? boxes[from - 1];
  const gap = next
    ? next.top > dragged.top
      ? next.top - dragged.top - dragged.height
      : dragged.top - next.top - next.height
    : 0;
  const room = dragged.height + Math.max(0, gap);
  const shifts = boxes.map((_, index) =>
    index === from
      ? 0
      : target > from && index > from && index <= target
        ? -room
        : target < from && index >= target && index < from
          ? room
          : 0,
  );
  return { target, shifts };
}

/** The card the dragged one goes before once dropped at `target` (null: the end). */
export function railDropBefore<T>(order: T[], from: number, target: number) {
  if (target === from) return undefined;
  return target > from ? (order[target + 1] ?? null) : order[target];
}
