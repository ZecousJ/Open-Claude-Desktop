import { useEffect, useState } from "react";
import type { Pluggable } from "unified";

/**
 * Syntax highlighting (highlight.js through lowlight, about 75 kB gzip) loads
 * the first time something on screen has code, not with the page, as the
 * original loads its highlighter with the views that need it. Until it arrives
 * code shows as plain text in the same box, and the views redraw highlighted.
 */
type Lowlight = ReturnType<typeof import("lowlight").createLowlight>;

let rehypeHighlight: Pluggable | undefined;
let lowlight: Lowlight | undefined;
let loading: Promise<void> | undefined;
const waiting = new Set<() => void>();

export function loadHighlight() {
  loading ??= Promise.all([
    import("rehype-highlight"),
    import("lowlight"),
  ]).then(([rehype, low]) => {
    rehypeHighlight = [rehype.default, { detect: false }];
    lowlight = low.createLowlight(low.common);
    for (const done of waiting) done();
    waiting.clear();
  });
  return loading;
}

/** Redraws the caller once highlighting has loaded, loading it when `needed`. */
function useHighlightLoaded(needed: boolean) {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (!needed || lowlight) return;
    const done = () => setLoaded(true);
    waiting.add(done);
    void loadHighlight();
    return () => {
      waiting.delete(done);
    };
  }, [needed]);
}

/** The rehype plugin for Markdown with code in it, once it has loaded. */
export function useRehypeHighlight(needed = true) {
  useHighlightLoaded(needed);
  return needed ? rehypeHighlight : undefined;
}

/** lowlight for a view that highlights by itself (the diff rows). */
export function useLowlight(needed = true) {
  useHighlightLoaded(needed);
  return needed ? lowlight : undefined;
}
