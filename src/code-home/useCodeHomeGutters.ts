import { useLayoutEffect, useRef } from "react";

/** O14/cc43287c9's tile-slot <=560px query runs inside the web frame's
 * 9px start/1px end inset. Actual 856px viewport: pane 568, tile 558, prompt 518.
 * Combined edges are 25px narrow and 41px wide. Keep fixed-menu coordinates. */
export function codeHomeGutter(paneWidth: number) {
  return paneWidth - 10 <= 560 ? 25 : 41;
}
export function useCodeHomeGutters() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previous = node.style.getPropertyValue("--code-home-gutter");
    const update = () => {
      if (node.clientWidth > 0)
        node.style.setProperty(
          "--code-home-gutter",
          `${codeHomeGutter(node.clientWidth)}px`,
        );
    };
    update();
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(update)
        : undefined;
    observer?.observe(node);
    const view = node.ownerDocument.defaultView;
    view?.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", update);
      if (previous) node.style.setProperty("--code-home-gutter", previous);
      else node.style.removeProperty("--code-home-gutter");
    };
  }, []);
  return ref;
}
