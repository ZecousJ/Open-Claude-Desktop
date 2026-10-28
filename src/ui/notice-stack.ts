import { useEffect, type RefObject } from "react";
import { errorToastBottom } from "./useErrorToastClearance";

/*
 * The corner notices (the toast stack, the limit and connection notices, the
 * error notice, the focus reminders) share one corner. The original keeps them
 * apart with a safe-area registry: each notice registers, the viewport rises
 * above the registered ones and above a composer near the bottom. Here a
 * notice that registers gets `--notice-lift`, the distance its resting `bottom:
 * 16px` rises by; the stylesheets add it to that bottom.
 */

const gap = 8;
const base = 16;
const regionSelector =
  ".composer-wrap, .code-model-menu, .model-menu, .code-model-submenu, .model-submenu";

/** Oldest first: the one that came first rests lowest. */
const notices: HTMLElement[] = [];
let frame: ReturnType<typeof setTimeout> | number | undefined;
let resize: ResizeObserver | undefined;

function visible(element: HTMLElement, view: Window) {
  if (
    element.closest(
      '.mobile-conversation, [hidden], [inert], [aria-hidden="true"], [data-state="closed"]',
    )
  )
    return false;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Puts every registered notice at its place; also run after a notice appears or resizes. */
export function layoutNotices() {
  frame = undefined;
  const first = notices[0];
  const view = first?.ownerDocument.defaultView;
  if (!first || !view) return;
  const document = first.ownerDocument;
  const regions = [...document.querySelectorAll<HTMLElement>(regionSelector)]
    .filter((region) => visible(region, view))
    .map((region) => ({
      rect: region.getBoundingClientRect(),
      nearBottomOnly: region.classList.contains("composer-wrap"),
    }));
  for (const region of document.querySelectorAll(regionSelector))
    resize?.observe(region);
  // The web error notice rests where its own clearance put it: the others
  // rise above it.
  let top = Infinity;
  const banner = document.querySelector<HTMLElement>(
    ".error-banner[style*='bottom']",
  );
  if (banner && visible(banner, view)) top = banner.getBoundingClientRect().top;
  const height = view.innerHeight;
  for (const notice of notices) {
    const box = notice.getBoundingClientRect();
    let bottom = errorToastBottom(height, box, regions);
    if (top !== Infinity) bottom = Math.max(bottom, height - top + gap);
    notice.style.setProperty("--notice-lift", `${bottom - base}px`);
    top = Math.min(top, height - bottom - box.height);
  }
}

/** Runs the layout once, a frame's time from now. */
export function scheduleNoticeLayout() {
  if (frame !== undefined || !notices.length) return;
  frame = setTimeout(layoutNotices, 16);
}

/** Registers a notice while it is shown. */
export function registerNotice(element: HTMLElement) {
  if (!notices.length && typeof ResizeObserver === "function")
    resize = new ResizeObserver(scheduleNoticeLayout);
  notices.push(element);
  resize?.observe(element);
  element.ownerDocument.defaultView?.addEventListener(
    "resize",
    scheduleNoticeLayout,
  );
  layoutNotices();
  return () => {
    const at = notices.indexOf(element);
    if (at !== -1) notices.splice(at, 1);
    if (notices.length) resize?.unobserve(element);
    else {
      resize?.disconnect();
      resize = undefined;
      if (frame !== undefined) clearTimeout(frame);
      frame = undefined;
    }
    element.style.removeProperty("--notice-lift");
    element.ownerDocument.defaultView?.removeEventListener(
      "resize",
      scheduleNoticeLayout,
    );
    scheduleNoticeLayout();
  };
}

/** A notice that shares the corner: it rises above the ones before it and above a composer near the bottom. */
export function useNoticeStack(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
) {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    return registerNotice(element);
  }, [enabled]);
}
