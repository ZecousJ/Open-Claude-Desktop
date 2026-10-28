import { useEffect, useState, type RefObject } from "react";

/**
 * Whether a page column is at least `width` wide. A full 960px column has room
 * for a page's search field itself; narrower windows show the lens that opens
 * it.
 */
export function useWideColumn(
  column: RefObject<HTMLElement | null>,
  width = 900,
) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = column.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWide(entry.contentRect.width >= width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  return wide;
}
