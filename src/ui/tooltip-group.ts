/*
 * Tooltip timing, from the original's TooltipGroup: a tooltip shows after the
 * pointer rests 300ms on its trigger and stays 200ms after it leaves. Within a
 * group only one tooltip shows; while one is open, or for 400ms after it
 * closed, the next trigger's tooltip shows at once and without motion, and the
 * one before goes the same way. Moving along a toolbar therefore reads as one
 * tooltip following the pointer.
 */

export const TOOLTIP_DELAY_MS = 300;
export const TOOLTIP_CLOSE_DELAY_MS = 200;
/** How long after a tooltip closes the next one still opens at once. */
export const TOOLTIP_WARM_MS = 400;
/** The tooltip's fade and scale, in and out (--motion-snap). */
export const TOOLTIP_MOTION_MS = 120;

export type TooltipHandle = { closeInstant: () => void };

export type TooltipGroupState = {
  current?: TooltipHandle;
  closedAt: number;
  delay: number;
  closeDelay: number;
};

export function createTooltipGroup(
  delay = TOOLTIP_DELAY_MS,
  closeDelay = TOOLTIP_CLOSE_DELAY_MS,
): TooltipGroupState {
  return { closedAt: -Infinity, delay, closeDelay };
}

/** Whether a tooltip opening now skips its delay and its motion. */
export function isWarm(group: TooltipGroupState, now: number) {
  return group.current !== undefined || now - group.closedAt < TOOLTIP_WARM_MS;
}

/** A tooltip opens: the group's previous one closes at once. */
export function claim(group: TooltipGroupState, handle: TooltipHandle) {
  if (group.current && group.current !== handle) group.current.closeInstant();
  group.current = handle;
}

/** A tooltip closes; the group stays warm for a moment. */
export function release(
  group: TooltipGroupState,
  handle: TooltipHandle,
  now: number,
) {
  if (group.current !== handle) return;
  group.current = undefined;
  group.closedAt = now;
}
