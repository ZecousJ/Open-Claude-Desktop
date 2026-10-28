import { useEffect, useRef, type RefObject } from "react";

/**
 * The open layers that answer Escape, oldest first. Escape closes only the
 * innermost one, so a menu in a dialog, a submenu in a menu and a popover over
 * voice mode each leave what is under them open. Document listeners run oldest
 * first, so each one checks it is the innermost before it acts; whoever handles
 * Escape on `document` for something that can sit under a layer asks
 * `hasEscapeLayer()` first.
 */
const escapeLayers: symbol[] = [];

/** Whether a menu, popover or dialog is open that will take the next Escape. */
export function hasEscapeLayer(): boolean {
  return escapeLayers.length > 0;
}

/**
 * Puts a layer on top of the Escape stack until `release` is called;
 * `isInnermost` says whether it is the one to act now.
 */
export function pushEscapeLayer() {
  const token = Symbol("escape-layer");
  escapeLayers.push(token);
  return {
    isInnermost: () => escapeLayers[escapeLayers.length - 1] === token,
    release() {
      const at = escapeLayers.lastIndexOf(token);
      if (at !== -1) escapeLayers.splice(at, 1);
    },
  };
}

/**
 * While `open`, Escape calls `onEscape` when this is the innermost layer, and
 * goes no further (no listener behind it, no other layer) once it has.
 */
export function useEscapeLayer(open: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const layer = pushEscapeLayer();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !layer.isInnermost()) return;
      event.stopImmediatePropagation();
      latest.current();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      layer.release();
    };
  }, [open]);
}

/**
 * Closes an open popover when the pointer is pressed outside every given
 * container, or Escape is pressed. Pass the element wrapping the trigger and,
 * for popovers rendered in a portal, the popover itself; pressing the trigger
 * then toggles instead of closing and reopening.
 *
 * `modal` makes the press only close it: the original's menus are modal, so the
 * control under the press does not also receive it, and the page behind does
 * not scroll while the popover is up.
 */
export function useDismiss(
  containers: RefObject<HTMLElement | null>[],
  open: boolean,
  onClose: () => void,
  { modal = false }: { modal?: boolean } = {},
) {
  const latest = useRef({ containers, onClose });
  latest.current = { containers, onClose };
  useEscapeLayer(open, () => latest.current.onClose());
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      latest.current.containers.some((c) =>
        c.current?.contains(target as Node),
      );
    const outside = (event: PointerEvent) => {
      if (inside(event.target)) return;
      latest.current.onClose();
      if (modal) swallowPress(inside);
    };
    // Capture phase for a modal popover, so the press is seen before the
    // control under it; a plain popover keeps the bubbling listener.
    document.addEventListener("pointerdown", outside, modal);
    // Wheel and touch scrolling outside the popover does nothing.
    const lock = (event: Event) => {
      if (!inside(event.target) && event.cancelable) event.preventDefault();
    };
    if (modal) {
      document.addEventListener("wheel", lock, { passive: false });
      document.addEventListener("touchmove", lock, { passive: false });
    }
    return () => {
      document.removeEventListener("pointerdown", outside, modal);
      document.removeEventListener("wheel", lock);
      document.removeEventListener("touchmove", lock);
    };
  }, [open, modal]);
}

/**
 * Swallows the rest of one press that began outside a modal popover: the
 * mouse-down (so focus and text selection stay put) and the click or context
 * menu that follow. It lets go once the press has ended.
 */
function swallowPress(inside: (target: EventTarget | null) => boolean) {
  const types = ["mousedown", "click", "auxclick", "contextmenu"] as const;
  const stop = (event: Event) => {
    if (inside(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const release = () => {
    for (const type of types) document.removeEventListener(type, stop, true);
    document.removeEventListener("pointerup", end, true);
    document.removeEventListener("pointercancel", end, true);
  };
  // The click is dispatched in the same task as the pointer-up; let it pass
  // through the swallowing listener before removing it.
  const end = () => setTimeout(release, 0);
  for (const type of types) document.addEventListener(type, stop, true);
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
}
