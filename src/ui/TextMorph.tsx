import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { prefersReducedMotion } from "./usePresence";

/*
 * A piece of a status line that changes in place, as the original's working
 * line does: when `morphKey` changes, the old text rises 3px while it fades
 * out, the new text rises into place from 3px below, and the slot's width
 * slides from the old width to the new one, all over 180ms on
 * cubic-bezier(.2,0,0,1). A null key is an empty slot, so a part that appears
 * or goes (a "·" separator, the token count) opens or closes its width the same
 * way. Children may change under the same key (a ticking timer) without a
 * morph. Under reduced motion the text is swapped at once.
 */
export const MORPH_MS = 180;
const MORPH_EASE = "cubic-bezier(0.2, 0, 0, 1)";

interface Face {
  key: string;
  children: ReactNode;
}

export function TextMorph({
  morphKey,
  className,
  children,
}: {
  morphKey: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const [shown, setShown] = useState<{ key: string | null; enter: boolean }>({
    key: morphKey,
    enter: false,
  });
  const [leaving, setLeaving] = useState<Face[]>([]);
  // What the current face last rendered: it is what leaves on a switch.
  const lastChildren = useRef<ReactNode>(children);
  const slot = useRef<HTMLSpanElement>(null);
  const width = useRef(0);
  if (morphKey !== shown.key) {
    const animate = !prefersReducedMotion();
    if (animate && shown.key !== null) {
      const gone: Face = { key: shown.key, children: lastChildren.current };
      setLeaving((faces) =>
        [
          ...faces.filter(
            (face) => face.key !== gone.key && face.key !== morphKey,
          ),
          gone,
        ].slice(-2),
      );
    } else if (!animate && leaving.length) setLeaving([]);
    setShown({ key: morphKey, enter: animate && morphKey !== null });
  }
  useLayoutEffect(() => {
    lastChildren.current = children;
  });
  // The width glides from the old face's to the new one's.
  const measured = useRef(false);
  useLayoutEffect(() => {
    const node = slot.current;
    if (!node) return;
    const before = width.current;
    const after = node.getBoundingClientRect().width;
    width.current = after;
    if (!measured.current) {
      measured.current = true;
      return;
    }
    if (
      Math.abs(before - after) < 0.5 ||
      typeof node.animate !== "function" ||
      prefersReducedMotion()
    )
      return;
    node.dataset.gliding = "";
    const glide = node.animate(
      [{ width: `${before}px` }, { width: `${after}px` }],
      { duration: MORPH_MS, easing: MORPH_EASE },
    );
    glide.onfinish = glide.oncancel = () => delete node.dataset.gliding;
    return () => glide.cancel();
  }, [shown.key]);
  // Keep the measured width current while the text changes under one key.
  useLayoutEffect(() => {
    if (slot.current && !slot.current.dataset.gliding)
      width.current = slot.current.getBoundingClientRect().width;
  });
  useEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), MORPH_MS + 20);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return (
    <span
      ref={slot}
      className={`text-morph${className ? ` ${className}` : ""}`}
    >
      {leaving.map((face) => (
        <span
          key={`leaving:${face.key}`}
          className="text-morph-face"
          data-leaving=""
          aria-hidden="true"
        >
          {face.children}
        </span>
      ))}
      {shown.key !== null && (
        <span
          key={shown.key}
          className="text-morph-face"
          data-enter={shown.enter || undefined}
        >
          {children}
        </span>
      )}
    </span>
  );
}
