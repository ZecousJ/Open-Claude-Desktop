import { useLayoutEffect, useRef } from "react";
import { useHost } from "../host/HostContext";

/** Keep a shown inline reply hint inside its real scrollable client box.
 * The 300ms opening (the shared tooltip delay), label and Escape handling stay with the button. */
export function useReplyTooltipClamp(
  open: boolean,
  text: string,
  {
    enabled = true,
    desktop = false,
    whileClosed = false,
    padding = 8,
  }: {
    enabled?: boolean;
    desktop?: boolean;
    /** Hidden inline hints still contribute to scroll overflow. */
    whileClosed?: boolean;
    padding?: number;
  } = {},
) {
  const ref = useRef<HTMLSpanElement>(null);
  const web = useHost().kind === "web";
  const clamp = enabled && (web || desktop);
  useLayoutEffect(() => {
    const tip = ref.current;
    if (
      (!open && !whileClosed) ||
      !clamp ||
      !tip ||
      tip.closest(".mobile-conversation")
    )
      return;
    const view = tip.ownerDocument.defaultView;
    if (!view) return;
    const authoredMaxWidth = view.getComputedStyle(tip).maxWidth;
    const authoredLimit = authoredMaxWidth?.endsWith("px")
      ? parseFloat(authoredMaxWidth)
      : Infinity;
    const keys = [
      "translate",
      "max-width",
      "white-space",
      "height",
      "overflow-wrap",
    ];
    const saved = keys.map((key) => [key, tip.style.getPropertyValue(key)]);
    const clips: HTMLElement[] = [];
    for (let node = tip.parentElement; node; node = node.parentElement) {
      const overflow = view.getComputedStyle(node).overflowX;
      if (overflow && overflow !== "visible" && node.clientWidth > 0)
        clips.push(node);
    }
    const position = () => {
      let left = padding,
        right = view.innerWidth - padding;
      for (const node of clips) {
        const box = node.getBoundingClientRect();
        left = Math.max(left, box.left + node.clientLeft);
        right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
      }
      if (right <= left) return;
      tip.style.removeProperty("translate");
      for (const key of [
        "max-width",
        "white-space",
        "height",
        "overflow-wrap",
      ]) {
        const previous = saved.find(([name]) => name === key)?.[1];
        if (previous) tip.style.setProperty(key, previous);
        else tip.style.removeProperty(key);
      }
      const natural = tip.getBoundingClientRect();
      tip.style.setProperty(
        "max-width",
        `${Math.min(right - left, authoredLimit)}px`,
      );
      if (natural.width > right - left) {
        tip.style.whiteSpace = "normal";
        tip.style.height = "auto";
        tip.style.overflowWrap = "anywhere";
      }
      const box = tip.getBoundingClientRect();
      const width = Math.min(box.width, right - left);
      const dx = Math.max(left, Math.min(box.left, right - width)) - box.left;
      if (dx) tip.style.translate = `${dx}px 0`;
    };
    position();
    const resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(position)
        : undefined;
    resize?.observe(tip);
    for (const node of clips) resize?.observe(node);
    view.addEventListener("resize", position);
    view.addEventListener("scroll", position, true);
    return () => {
      resize?.disconnect();
      view.removeEventListener("resize", position);
      view.removeEventListener("scroll", position, true);
      for (const [key, value] of saved) {
        if (value) tip.style.setProperty(key, value);
        else tip.style.removeProperty(key);
      }
    };
  }, [open, text, clamp, whileClosed, padding]);
  return ref;
}
