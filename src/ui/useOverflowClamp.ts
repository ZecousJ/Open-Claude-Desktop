import { useLayoutEffect, useRef, useState, type DependencyList } from "react";

/**
 * Whether an element's content is taller than `limit` px, kept current as it
 * resizes. The caller clamps it with CSS and offers Show more while clipped.
 */
export function useOverflowClamp<T extends HTMLElement>(
  limit: number,
  deps: DependencyList,
) {
  const ref = useRef<T>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollHeight > limit + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, deps);
  return { ref, clipped };
}
