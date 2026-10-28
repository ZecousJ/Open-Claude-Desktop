import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { BrowserBounds } from "../../shared/browser";
import { boxesOverlap } from "./browser-model";
import type { BrowserBridge } from "./useBrowserState";

/** Elements that must stay visible over the page. */
const overlays =
  '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';

/**
 * Whether an app menu or dialog covers the page's place: any modal dialog
 * (it dims the whole window), or a menu, list or popover that overlaps it.
 */
export function pageCovered(place: DOMRect, root: ParentNode = document) {
  if (place.width <= 0 || place.height <= 0) return false;
  for (const element of root.querySelectorAll<HTMLElement>(overlays)) {
    if (element.getAttribute("aria-modal") === "true") return true;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && boxesOverlap(box, place))
      return true;
  }
  return false;
}

/**
 * Lays the main process's page over the placeholder: its box goes to
 * `browserSetBounds` whenever it moves or changes size. The page is a
 * native view drawn above the app, so while an app menu or dialog covers
 * the placeholder the page leaves the window (`browserOcclude`) and a
 * still of it stands in (`cover.snapshot`).
 */
export function useBrowserView(
  conversationId: string,
  bridge: BrowserBridge | undefined,
  place: RefObject<HTMLElement | null>,
) {
  const [cover, setCover] = useState<{ on: boolean; snapshot?: string }>({
    on: false,
  });
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useLayoutEffect(() => {
    const element = place.current;
    if (!bridge || !element) return;
    let last = "";
    let frame = 0;
    const send = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const bounds: BrowserBounds = {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
      };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === last) return;
      last = key;
      void bridge.browserSetBounds(conversationId, bounds).catch(() => {});
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    addEventListener("resize", schedule);
    // The card can move without changing size (the sidebar is dragged, a
    // panel beside it opens): look again twice a second.
    const timer = setInterval(schedule, 500);
    send();
    return () => {
      resize.disconnect();
      removeEventListener("resize", schedule);
      clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [conversationId, bridge, place]);

  useEffect(() => {
    const element = place.current;
    if (!bridge || !element) return;
    let covered = false;
    let frame = 0;
    // Calls go one after another: a late "covered" answer must not land
    // after the "uncovered" that followed it.
    const occlude = (on: boolean) => {
      const next = queue.current.then(() =>
        bridge.browserOcclude(conversationId, on).catch(() => ({})),
      );
      queue.current = next;
      return next as Promise<{ snapshot?: string }>;
    };
    const check = () => {
      frame = 0;
      const now = pageCovered(element.getBoundingClientRect());
      if (now === covered) return;
      covered = now;
      if (now) {
        setCover({ on: true });
        void occlude(true).then((result) => {
          if (covered) setCover({ on: true, snapshot: result.snapshot });
        });
      } else {
        setCover({ on: false });
        void occlude(false);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-modal", "style", "class"],
    });
    schedule();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (covered) void occlude(false);
    };
  }, [conversationId, bridge, place]);

  return cover;
}
