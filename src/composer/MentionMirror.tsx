import { useLayoutEffect, useRef, type RefObject } from "react";
import type { MentionRange } from "./mention";

/**
 * The accent behind chosen `@path` tokens in the Code composer's plain text
 * area. A copy of the draft lies under the transparent text area in the same
 * font and wrapping, its text invisible and each token marked, and follows the
 * text area's scrolling. The tokens themselves delete and select as one
 * (mention.ts).
 */
export function MentionMirror({
  text,
  ranges,
  field,
}: {
  text: string;
  ranges: readonly MentionRange[];
  field: RefObject<HTMLElement | null>;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const area = field.current;
    const copy = mirror.current;
    if (!area || !copy) return;
    const sync = () => {
      // A scrollbar narrows the text area's lines; the copy keeps the same.
      copy.style.paddingRight = `${area.offsetWidth - area.clientWidth}px`;
      copy.scrollTop = area.scrollTop;
    };
    sync();
    area.addEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    return () => {
      area.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  });
  const parts: (string | { token: string; at: number })[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) parts.push(text.slice(at, range.start));
    parts.push({ token: text.slice(range.start, range.end), at: range.start });
    at = range.end;
  }
  parts.push(text.slice(at));
  return (
    <div className="composer-mention-mirror" ref={mirror} aria-hidden="true">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <mark key={`${part.at}-${index}`}>{part.token}</mark>
        ),
      )}
      {/* A last empty line still takes its height, as in the text area. */}
      {"​"}
    </div>
  );
}
