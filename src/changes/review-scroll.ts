import { prefersReducedMotion } from "../ui/usePresence";

/*
 * The review jump, after the original's: a change chosen from a list scrolls
 * into place over 400ms on an ease-out quad, re-aiming every frame in case the
 * content above it moves, and then flashes an accent ring (0.9s,
 * `.review-landed` in changes-panel.css). A target already in full view only
 * flashes. Reduced motion jumps at once and does not flash.
 */

export const REVIEW_SCROLL_MS = 400;
/** How long the landed ring stays marked (its animation is 0.9s). */
export const REVIEW_FLASH_MS = 1000;

/** The ease-out quad the jump follows. */
export function easeOutQuad(t: number) {
  return 1 - (1 - t) ** 2;
}

/**
 * The step a frame takes toward the target: the share of the distance still
 * left that this frame's progress covers, so a target that moves is
 * followed without overshooting.
 */
export function stepShare(previous: number, eased: number) {
  return previous < 1 ? (eased - previous) / (1 - previous) : 1;
}

/** The nearest scrolling ancestor of `element`. */
function scrollerOf(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * Scrolls `target` to the top of its scroller and flashes it. Returns a
 * cancel function for a jump still under way.
 */
export function reviewJump(target: HTMLElement) {
  const scroller = scrollerOf(target);
  const flash = () => {
    target.classList.remove("review-landed");
    if (prefersReducedMotion()) return;
    // Restart the ring if it was still showing.
    void target.offsetWidth;
    target.classList.add("review-landed");
    setTimeout(() => target.classList.remove("review-landed"), REVIEW_FLASH_MS);
  };
  if (!scroller) return () => {};
  const goal = () => {
    const box = scroller.getBoundingClientRect();
    const top = target.getBoundingClientRect().top;
    return Math.max(
      0,
      Math.min(
        scroller.scrollTop + top - box.top,
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
  };
  const box = scroller.getBoundingClientRect();
  const own = target.getBoundingClientRect();
  if (own.top >= box.top && own.bottom <= box.bottom) {
    flash();
    return () => {};
  }
  if (prefersReducedMotion()) {
    scroller.scrollTop = goal();
    return () => {};
  }
  const start = performance.now();
  let previous = 0;
  let frame = requestAnimationFrame(function step(now) {
    const progress = Math.min((now - start) / REVIEW_SCROLL_MS, 1);
    const eased = easeOutQuad(progress);
    const share = stepShare(previous, eased);
    previous = eased;
    scroller.scrollTop += (goal() - scroller.scrollTop) * share;
    if (progress < 1) frame = requestAnimationFrame(step);
    else flash();
  });
  return () => cancelAnimationFrame(frame);
}
