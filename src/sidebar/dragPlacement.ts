/**
 * The geometry of a sidebar row drag, after the original's: the rows are
 * measured once when the drag starts, the pointer is tested against those
 * measurements rather than against the moving rows, and the other rows slide by
 * whole row steps while the dragged row's own place stays, empty. The layout
 * never changes during a drag, so every motion is a transform.
 */

/** A row as measured when the drag started (viewport px at that moment). */
export interface MeasuredRow<T = string> {
  key: T;
  top: number;
}

export interface DragLayout<T = string> {
  /** The Pinned rows in order, with their midpoints. */
  pinned: (MeasuredRow<T> & { mid: number })[];
  /** Everything under the Pinned list that slides with it: labels, rows, buttons. */
  below: MeasuredRow<T>[];
  /** The dragged row's top, and whether it is pinned (its index there). */
  srcY: number;
  srcPinnedIndex: number;
  /** The Pinned section's foot; a pinned row released below it is unpinned. */
  pinnedBottom: number;
  /** The top of the section after Pinned. */
  nextSectionTop: number;
  /** One row and the gap under it. */
  rowStep: number;
}

/**
 * A custom group's part of the list as measured when the drag started: its
 * heading, its rows and its empty line. `id` is null for Ungrouped.
 */
export interface GroupZone {
  id: string | null;
  label: string;
  top: number;
  bottom: number;
}

/** The group a release would move the row into (null id: out of its group). */
export interface GroupTarget {
  id: string | null;
  label: string;
}

/**
 * What a release would do now: pin or move to `slot`, unpin, move into a
 * custom group, or nothing.
 */
export interface DragIntent {
  slot: number | null;
  unpin: boolean;
  group: GroupTarget | null;
}

/**
 * The custom group a release at `y` moves the row into. Undefined while the
 * pointer is over no zone that takes the row, so the pin logic decides; null
 * over the zone the row is already in, where a release does nothing (custom
 * groups keep no order of their own). A pinned row over Ungrouped is left to
 * the pin logic too, which unpins it there.
 */
export function groupDrop(
  zones: GroupZone[],
  y: number,
  source: { zone: number; pinned: boolean },
): GroupTarget | null | undefined {
  const index = zones.findIndex((zone) => y >= zone.top && y < zone.bottom);
  if (index < 0) return undefined;
  const zone = zones[index];
  if (source.pinned && zone.id === null) return undefined;
  if (index === source.zone) return null;
  return { id: zone.id, label: zone.label };
}

/** Whether two intents ask for the same release (the list renders only a change). */
export function sameIntent(a: DragIntent, b: DragIntent) {
  return (
    a.slot === b.slot &&
    a.unpin === b.unpin &&
    (a.group === null) === (b.group === null) &&
    a.group?.id === b.group?.id
  );
}

/**
 * The intent for the pointer at `y` (viewport px, already corrected for any
 * scroll since the measurement). A row from below takes a slot while the
 * pointer is over Pinned, which reaches down to the next section, and a row
 * further when the slot is already the last one (so the slot does not flicker
 * at the section's foot). A pinned row unpins below Pinned, and dropping it
 * onto its own place does nothing.
 */
export function dragIntent<T>(
  layout: DragLayout<T>,
  y: number,
  previousSlot: number | null,
): DragIntent {
  const {
    pinned,
    srcPinnedIndex,
    pinnedBottom,
    nextSectionTop,
    rowStep,
    srcY,
  } = layout;
  const srcPinned = srcPinnedIndex >= 0;
  const reach = srcPinned
    ? 0
    : Math.min(Math.max(nextSectionTop - pinnedBottom, 0), rowStep) +
      (pinned.length > 0 &&
      previousSlot === pinned.length &&
      nextSectionTop < srcY
        ? rowStep
        : 0);
  if (y >= pinnedBottom + reach)
    return { slot: null, unpin: srcPinned, group: null };
  let slot = pinned.findIndex((row) => y < row.mid);
  if (slot < 0) slot = pinned.length;
  if (srcPinned && (slot === srcPinnedIndex || slot === srcPinnedIndex + 1))
    return { slot: null, unpin: false, group: null };
  return { slot, unpin: false, group: null };
}

/**
 * Which rows slide, by how many row steps (down is positive). A pinned row
 * moving within Pinned: the rows between the slot and its old place slide
 * toward that place. A row coming in from below: the pinned rows from the
 * slot down, and everything below Pinned that stands above the dragged row,
 * slide down a row, so the dragged row's empty place takes up the change and
 * nothing under it moves. Nothing slides into an empty Pinned section (its
 * "Drop here" row is the slot) or while no slot is taken.
 */
export function dragShifts<T>(
  layout: DragLayout<T>,
  slot: number | null,
): Map<T, number> {
  const shifts = new Map<T, number>();
  if (slot === null) return shifts;
  const { pinned, below, srcY, srcPinnedIndex } = layout;
  if (srcPinnedIndex >= 0) {
    const slotTop = slot < pinned.length ? pinned[slot].top : Infinity;
    const from = Math.min(slotTop, srcY),
      to = Math.max(slotTop, srcY),
      step = slotTop < srcY ? 1 : -1;
    pinned.forEach((row, index) => {
      if (index !== srcPinnedIndex && row.top >= from && row.top < to)
        shifts.set(row.key, step);
    });
    return shifts;
  }
  if (!pinned.length) return shifts;
  for (let index = slot; index < pinned.length; index++)
    shifts.set(pinned[index].key, 1);
  for (const row of below) if (row.top < srcY) shifts.set(row.key, 1);
  return shifts;
}

/**
 * How far the dragged row's own place lies above (negative) or below the
 * place it takes on a release into `slot`, in px; null for an empty Pinned
 * section, whose slot the caller measures.
 */
export function landingOffset<T>(
  layout: DragLayout<T>,
  slot: number,
): number | null {
  const { pinned, srcY, srcPinnedIndex, rowStep } = layout;
  if (!pinned.length) return null;
  if (srcPinnedIndex >= 0) {
    const to = slot > srcPinnedIndex ? slot - 1 : slot;
    return pinned[to].top - srcY;
  }
  const top =
    slot < pinned.length ? pinned[slot].top : pinned.at(-1)!.top + rowStep;
  return top - srcY;
}

/**
 * The reorder a release into `slot` asks for: before the row now there, or
 * after the last one (skipping the dragged row itself).
 */
export function slotTarget<T>(
  layout: DragLayout<T>,
  slot: number,
): { targetId?: T; position: "before" | "after" } {
  const rows = layout.pinned.filter(
    (_, index) => index !== layout.srcPinnedIndex,
  );
  const at =
    layout.srcPinnedIndex >= 0 && slot > layout.srcPinnedIndex
      ? slot - 1
      : slot;
  if (!rows.length) return { position: "before" };
  return at < rows.length
    ? { targetId: rows[at].key, position: "before" }
    : { targetId: rows.at(-1)!.key, position: "after" };
}
