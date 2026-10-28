import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/*
 * Overlays open and close symmetrically, as the original's Base UI popups do
 * with their starting/ending styles: an element stays on screen for its exit
 * animation, marked `data-state="closed"`, and only then leaves the document.
 * CSS animates the entrance on the element itself and the exit on
 * `[data-state=closed]`. Under reduced motion (the app's setting or the
 * system's) there is no exit to wait for: the element goes at once.
 */

export type PresenceState = "open" | "closed";

/** True when the app's Motion setting or the system asks for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement.dataset.motion === "reduced" ||
    !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Keeps an overlay mounted for `exitMs` after `open` turns false. Render the
 * overlay while `mounted` and put `data-state={state}` on it; reopening
 * during the exit takes it straight back to "open".
 */
export function usePresence(
  open: boolean,
  exitMs: number,
): { mounted: boolean; state: PresenceState } {
  const [exiting, setExiting] = useState(false);
  const [previous, setPrevious] = useState(open);
  // Derived during render, so the closing render already keeps the element.
  if (previous !== open) {
    setPrevious(open);
    setExiting(!open && exitMs > 0 && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(false), exitMs);
    return () => clearTimeout(timer);
  }, [exiting, exitMs]);
  return { mounted: open || exiting, state: open ? "open" : "closed" };
}

const dialogRoles = new Set(["dialog", "alertdialog", "menu", "listbox"]);

/**
 * The exit for an overlay its owner renders conditionally (`{open &&
 * <Dialog/>}`), where nothing is left to keep it mounted: when the
 * component unmounts, the element `ref` points at is put back where it was,
 * inert and marked `data-state="closed"`, and removed after `exitMs`. The
 * node is React's own (no copy), so fields, canvases and scroll positions
 * look as they did. It no longer reads as an open dialog to code that looks
 * for one (`[role=dialog]`, `[aria-modal]`).
 */
export function useExitPresence(
  ref: RefObject<HTMLElement | null>,
  exitMs: number,
) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.dataset.state = "open";
    return () => {
      const parent = node.parentNode;
      const next = node.nextSibling;
      if (!parent || exitMs <= 0 || prefersReducedMotion()) return;
      // React removes the node right after this cleanup, in the same commit;
      // a microtask runs before the next paint. A node still attached (a
      // Strict Mode re-run) is left alone.
      queueMicrotask(() => {
        if (node.isConnected || !parent.isConnected) return;
        node.dataset.state = "closed";
        node.setAttribute("inert", "");
        node.setAttribute("aria-hidden", "true");
        for (const element of [node, ...node.querySelectorAll("[role]")]) {
          if (dialogRoles.has(element.getAttribute("role") ?? "")) {
            element.removeAttribute("role");
            element.removeAttribute("aria-modal");
          }
        }
        parent.insertBefore(
          node,
          next && next.parentNode === parent ? next : null,
        );
        setTimeout(() => node.remove(), exitMs);
      });
    };
  }, []);
}
