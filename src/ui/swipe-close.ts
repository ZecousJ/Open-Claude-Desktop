import { useEffect, useRef, type RefObject } from "react";
import { reducedMotion } from "./page-fade";

/** How far a finger moves before the gesture counts (CSS px). */
export const swipeSlop = 10;

/**
 * Whether a finger that moved `along` px towards the closing side (positive to
 * the left) and `across` px the other way starts dragging the sheet: past the
 * slop, towards the closing side, and more that way than across. The live
 * claude.ai bundle's phone sheet gives up on any other gesture.
 */
export const swipeStarts = (along: number, across: number) =>
  Math.max(Math.abs(along), Math.abs(across)) < swipeSlop
    ? undefined
    : along > 0 && Math.abs(across) <= along;

/**
 * Whether a drag let go after `along` px in `elapsed` ms closes a sheet `width`
 * px wide: past a third of it, or faster than 0.5 px/ms.
 */
export const swipeCloses = (along: number, elapsed: number, width: number) =>
  along > width / 3 || along / Math.max(1, elapsed) > 0.5;

/** The phone sheet's duration and ease-out. */
const sheetMotion = "transform 0.3s cubic-bezier(0.165, 0.84, 0.44, 1)";

/**
 * On a phone the sidebar is a full-screen sheet; a swipe to the left takes it
 * away and shows the conversation again. The sheet follows the finger once the
 * gesture is clearly sideways; a short or slow swipe springs back.
 */
export function useSwipeClose(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const phone = matchMedia("(max-width: 639.98px)");
    let start: { x: number; y: number; at: number } | undefined;
    let sideways: boolean | undefined;
    let dx = 0;
    const reset = (animate: boolean) => {
      // Reduced motion: the sheet jumps back instead of sliding.
      if (reducedMotion()) animate = false;
      el.style.transition = animate ? sheetMotion : "";
      el.style.transform = "";
      if (animate)
        window.setTimeout(() => {
          el.style.transition = "";
        }, 320);
    };
    const down = (event: TouchEvent) => {
      if (!phone.matches || event.touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], [role='menu']"))
        return;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, at: Date.now() };
      sideways = undefined;
      dx = 0;
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0]!;
      const x = touch.clientX - start.x;
      const y = touch.clientY - start.y;
      if (sideways === undefined) {
        sideways = swipeStarts(-x, y);
        // Any other gesture is left alone until the finger lifts.
        if (sideways === false) start = undefined;
      }
      if (!sideways) return;
      dx = Math.min(0, x);
      el.style.transition = "";
      el.style.transform = `translateX(${dx}px)`;
    };
    const up = () => {
      if (!start) return;
      const elapsed = Date.now() - start.at;
      start = undefined;
      if (sideways && swipeCloses(-dx, elapsed, el.clientWidth)) {
        el.style.transition = reducedMotion() ? "" : sheetMotion;
        el.style.transform = "translateX(-100%)";
        window.setTimeout(() => {
          close.current();
          // Once the sheet is hidden its own styles take over again.
          window.setTimeout(() => {
            el.style.transition = "";
            el.style.transform = "";
          }, 60);
        }, 290);
      } else if (sideways) reset(true);
      sideways = undefined;
    };
    // A cancelled touch (the browser took the gesture) springs back.
    const cancel = () => {
      if (!start) return;
      start = undefined;
      if (sideways) reset(true);
      sideways = undefined;
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", cancel);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", cancel);
      reset(false);
    };
  }, [ref, enabled]);
}
