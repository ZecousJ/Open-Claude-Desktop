import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

type Rect = Pick<
  DOMRectReadOnly,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;
/** A whole-label overlay is valid only when the real raw text occupies one
 * visible line inside the input. This is a geometry contract, not a claim
 * that a textarea supports the source editor's atomic inline-flex layout. */
export function skillReferenceFits(rects: readonly Rect[], bounds: Rect) {
  const visible = rects.filter((rect) => rect.width > 0.1 && rect.height > 0);
  if (!visible.length || bounds.width <= 0) return false;
  const first = visible[0]!;
  return visible.every(
    (rect) =>
      Math.abs(rect.top - first.top) <= 0.5 &&
      Math.abs(rect.bottom - first.bottom) <= 0.5 &&
      rect.left >= bounds.left - 0.5 &&
      rect.right <= bounds.right + 0.5,
  );
}

export function useSkillReferenceLayout(
  raw: RefObject<HTMLSpanElement | null>,
) {
  // Unknown geometry must never paint an incorrectly positioned reference.
  const [singleLine, setSingleLine] = useState(false);
  const alive = useRef(true);
  const measure = useCallback(() => {
    if (!alive.current) return;
    const node = raw.current;
    const mirror = node?.closest<HTMLElement>(".composer-skill-mirror");
    let fits = false;
    if (node && mirror) {
      const range = node.ownerDocument.createRange();
      if (typeof range.getClientRects === "function") {
        range.selectNodeContents(node);
        const bounds = mirror.getBoundingClientRect();
        const style = getComputedStyle(mirror);
        const left = bounds.left + (parseFloat(style.paddingLeft) || 0);
        const right = bounds.right - (parseFloat(style.paddingRight) || 0);
        fits = skillReferenceFits([...range.getClientRects()], {
          left,
          right,
          width: right - left,
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
        });
      }
      range.detach?.();
    }
    setSingleLine((current) => (current === fits ? current : fits));
  }, [raw]);
  // The parent mirror synchronizes the actual textarea font/padding in its
  // layout effect. Recheck once after those effects, before browser paint.
  useLayoutEffect(() => {
    measure();
    queueMicrotask(measure);
  });
  useLayoutEffect(() => {
    alive.current = true;
    const mirror = raw.current?.closest<HTMLElement>(".composer-skill-mirror");
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    if (mirror) observer?.observe(mirror);
    window.addEventListener("resize", measure);
    const fonts = raw.current?.ownerDocument.fonts;
    fonts?.addEventListener?.("loadingdone", measure);
    void fonts?.ready?.then(
      () => {
        if (alive.current) measure();
      },
      () => {},
    );
    return () => {
      alive.current = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      fonts?.removeEventListener?.("loadingdone", measure);
    };
  }, [measure, raw]);
  return singleLine;
}
