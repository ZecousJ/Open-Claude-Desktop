import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";

/** Whether a table is wider than the column it sits in. */
export function scrollsSideways(box: {
  scrollWidth: number;
  clientWidth: number;
}) {
  return box.scrollWidth > box.clientWidth + 1;
}

/**
 * A reply's table. One wider than its column scrolls sideways, so its scroll
 * area takes the keyboard's focus and is named for a screen reader.
 */
export function MarkdownTable({ children }: { children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setScrolls(scrollsSideways(node));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={box}
      className="markdown-table prose-scroll u-scroll-fade-x"
      {...(scrolls
        ? {
            tabIndex: 0,
            role: "group",
            "aria-label": t("Table, scrolls sideways"),
          }
        : {})}
    >
      <table>{children}</table>
    </div>
  );
}
