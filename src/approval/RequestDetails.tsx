import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * The part of an approval card between its title and its buttons. The card
 * stops at 60% of the window's height and this part scrolls inside it, its
 * edges fading where there is more to see. Only while it scrolls is it a
 * keyboard stop of its own, "Request details", so the arrow keys can move
 * through a long diff.
 */
export function RequestDetails({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setScrolls(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div
      ref={ref}
      className="approval-details u-scroll-fade-y"
      role={scrolls ? "group" : undefined}
      aria-label={scrolls ? "Request details" : undefined}
      tabIndex={scrolls ? 0 : undefined}
    >
      {children}
    </div>
  );
}
