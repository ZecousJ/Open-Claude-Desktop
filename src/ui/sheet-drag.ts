import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * On a phone the file viewer is a sheet over the lower part of the screen
 * (artifact-narrow.css). Like the iOS app's sheets it follows a finger dragging
 * it down, by its header or by content already scrolled to the top, and goes
 * away when let go far or fast enough; otherwise it springs back. A tap on the
 * dimmed conversation above closes it too.
 */
export function useSheetDrag(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
  resetKey?: string,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reset = () => {
      delete el.dataset.dismissed;
      el.style.transition = "";
      el.style.transform = "";
      el.style.removeProperty("--sheet-dim");
    };
    // A reused node starts its next document or expanded view before paint.
    reset();
    if (!enabled) return;
    const phone = matchMedia("(max-width: 639.98px)");
    // Only while the rules make it a sheet (not a page opened expanded).
    const sheet = () =>
      phone.matches && getComputedStyle(el).position === "fixed";
    let start: { x: number; y: number; at: number } | undefined;
    let downward: boolean | undefined;
    let dy = 0;
    let dismissTimer: number | undefined;
    let reboundTimer: number | undefined;
    let closedByDrag = false;
    const place = (offset: number) => {
      el.style.transform = offset ? `translateY(${offset}px)` : "";
      const dim = Math.max(0, 1 - offset / Math.max(1, el.offsetHeight));
      if (offset) el.style.setProperty("--sheet-dim", dim.toFixed(3));
      else el.style.removeProperty("--sheet-dim");
    };
    const dismiss = () => {
      el.dataset.dismissed = "true";
      el.style.transition = "transform 0.2s ease-out, box-shadow 0.2s ease-out";
      place(el.offsetHeight);
      window.clearTimeout(reboundTimer);
      dismissTimer = window.setTimeout(() => {
        dismissTimer = undefined;
        closedByDrag = true;
        close.current();
      }, 190);
    };
    // The content under the finger, if it can still scroll up: then the
    // drag is that scroll's, not the sheet's.
    const scrolled = (target: Element | null) => {
      for (let node = target; node && node !== el; node = node.parentElement)
        if (node.scrollTop > 0) return true;
      return false;
    };
    const down = (event: TouchEvent) => {
      if (!sheet() || event.touches.length !== 1 || el.dataset.dismissed)
        return;
      const target = event.target as Element | null;
      if (
        target?.closest("input, textarea, [contenteditable], [role='menu']") ||
        scrolled(target)
      )
        return;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, at: Date.now() };
      downward = undefined;
      dy = 0;
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0]!;
      const x = touch.clientX - start.x;
      const y = touch.clientY - start.y;
      if (downward === undefined && Math.hypot(x, y) > 10) {
        downward = y > 0 && y > Math.abs(x) * 1.2;
        // Caught while still rising: the opening move ends where it was
        // going, so the finger moves the sheet from there.
        if (downward) for (const a of el.getAnimations()) a.finish();
      }
      if (!downward) return;
      if (event.cancelable) event.preventDefault();
      dy = Math.max(0, y);
      el.style.transition = "";
      place(dy);
    };
    const up = () => {
      if (!start) return;
      const elapsed = Math.max(1, Date.now() - start.at);
      const fast = dy / elapsed > 0.5 && dy > 40;
      const far = dy > Math.min(160, el.offsetHeight * 0.25);
      const dragged = downward;
      start = undefined;
      downward = undefined;
      if (!dragged) return;
      if (far || fast) return dismiss();
      el.style.transition =
        "transform 0.22s cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 0.22s";
      place(0);
      window.clearTimeout(reboundTimer);
      reboundTimer = window.setTimeout(() => {
        reboundTimer = undefined;
        el.style.transition = "";
      }, 240);
    };
    // A tap above the sheet lands on its ::before (the target is the sheet
    // itself, above its top edge).
    const click = (event: MouseEvent) => {
      if (
        sheet() &&
        event.target === el &&
        event.clientY < el.getBoundingClientRect().top &&
        !el.dataset.dismissed
      )
        dismiss();
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    el.addEventListener("click", click);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
      el.removeEventListener("click", click);
      window.clearTimeout(dismissTimer);
      window.clearTimeout(reboundTimer);
      // An already-dismissed sheet keeps its marker during removal so the
      // panel observer does not animate it out again (spring-panels.ts).
      // If React reuses the node, the next setup above resets it instead.
      if (!closedByDrag) reset();
    };
  }, [ref, enabled, resetKey]);
}
