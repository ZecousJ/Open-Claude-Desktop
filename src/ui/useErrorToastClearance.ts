import { useLayoutEffect, useRef } from "react";

const margin = 16;
const topMargin = 8;
const nearBottom = 200;
const regionSelector =
  ".composer-wrap, .code-model-menu, .model-menu, .code-model-submenu, .model-submenu";
const webRegions = regionSelector
  .split(", ")
  .map((selector) => `.app.web:not(.mobile-conversation) ${selector}`)
  .join(", ");
const visibilityAttributes = [
  "class",
  "hidden",
  "aria-hidden",
  "inert",
  "data-state",
];
type Rect = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

/**
 * horizontal intersection, Code composer's 200px near-bottom threshold, then a
 * 16px gap. Clamp to the actual toast height so Close stays visible.
 */
export function errorToastBottom(
  viewportHeight: number,
  toast: Rect,
  regions: readonly { rect: Rect; nearBottomOnly: boolean }[],
) {
  let clearance = 0;
  for (const { rect, nearBottomOnly } of regions) {
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.top >= viewportHeight ||
      rect.right <= toast.left ||
      rect.left >= toast.right ||
      (nearBottomOnly && viewportHeight - rect.bottom > nearBottom)
    )
      continue;
    clearance = Math.max(clearance, viewportHeight - rect.top);
  }
  return Math.max(
    0,
    Math.min(
      margin + Math.round(clearance),
      viewportHeight - toast.height - topMargin,
    ),
  );
}

/** Only the generic web error banner uses this; quota/native notices keep
 * their captured corner placement. All writes occur before initial paint
 * or in one frame shared by geometry/DOM updates, without React rerenders. */
export function useErrorToastClearance(enabled: boolean, message: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const toast = ref.current;
    if (!enabled || !toast || toast.closest(".mobile-conversation")) return;
    const document = toast.ownerDocument;
    const view = document.defaultView;
    if (!view) return;
    const properties = ["bottom", "max-height", "overflow-y"];
    const previous = properties.map((key) => [
      key,
      toast.style.getPropertyValue(key),
      toast.style.getPropertyPriority(key),
    ]);
    let live = true;
    let frame: number | undefined;
    let dirty = true;
    let regions: HTMLElement[] = [];
    const watched = new Set<Element>();
    const write = (key: string, value: string) => {
      if (toast.style.getPropertyValue(key) !== value)
        toast.style.setProperty(key, value);
    };
    const visible = (element: HTMLElement) => {
      if (
        element.closest(
          '.mobile-conversation, [hidden], [inert], [aria-hidden="true"], [data-state="closed"]',
        )
      )
        return false;
      const style = view.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse"
      );
    };
    const sync = () => {
      regions = [...document.querySelectorAll<HTMLElement>(webRegions)];
      const next = new Set<Element>([toast]);
      for (const region of regions)
        for (let node: Element | null = region; node; node = node.parentElement)
          next.add(node);
      for (const node of watched)
        if (!next.has(node)) {
          resize.unobserve(node);
          watched.delete(node);
        }
      for (const node of next)
        if (!watched.has(node)) {
          resize.observe(node);
          watched.add(node);
        }
      dirty = false;
    };
    const measure = () => {
      if (!live) return;
      if (dirty) sync();
      // Bound long errors before reading their height; the Close control
      // remains at the top of the scrollable card on a short viewport.
      write("max-height", `${Math.max(0, view.innerHeight - margin)}px`);
      write("overflow-y", "auto");
      const box = toast.getBoundingClientRect();
      const obstacles = regions.filter(visible).map((region) => ({
        rect: region.getBoundingClientRect(),
        nearBottomOnly: region.classList.contains("composer-wrap"),
      }));
      write(
        "bottom",
        `${errorToastBottom(view.innerHeight, box, obstacles)}px`,
      );
    };
    const schedule = () => {
      if (!live || frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const resize = new ResizeObserver(schedule);
    const relevant = (node: Node) =>
      node.nodeType === 1 &&
      ((node as Element).matches(regionSelector) ||
        Boolean((node as Element).querySelector(regionSelector)));
    const changes = new MutationObserver((records) => {
      if (
        records.some((record) =>
          record.type === "childList"
            ? [...record.addedNodes, ...record.removedNodes].some(relevant)
            : visibilityAttributes.includes(record.attributeName ?? "") &&
              relevant(record.target),
        )
      ) {
        dirty = true;
        schedule();
      }
    });
    // Self-written styles and token/text changes do not enter this observer.
    changes.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: visibilityAttributes,
    });
    view.addEventListener("resize", schedule);
    view.addEventListener("scroll", schedule, true);
    measure();
    return () => {
      live = false;
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      view.removeEventListener("resize", schedule);
      view.removeEventListener("scroll", schedule, true);
      for (const [key, value, priority] of previous) {
        if (value) toast.style.setProperty(key, value, priority);
        else toast.style.removeProperty(key);
      }
    };
  }, [enabled, message]);
  return ref;
}
