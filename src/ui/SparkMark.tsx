import { useLayoutEffect, useRef } from "react";
import { Star } from "./Star";

/**
 * The star under a Chat reply while it writes: its frames step from a dot to
 * the full star and back in 720ms, in #d97757, at full opacity (no breathing,
 * the owner's review). As the text grows the star follows its end with a 220ms
 * critically damped glide. Drawn with Claudex's own star glyph.
 */
export function SparkMark({
  size = 32,
  follow = true,
}: {
  size?: number;
  /** Glide after the end of the text as it grows. */
  follow?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const top = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !follow) return;
    // Its place in the layout, not on screen: the transcript scrolls inside
    // its own box, and scrolling must never read as the text growing.
    let now = 0;
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.offsetParent as HTMLElement | null
    )
      now += node.offsetTop;
    const before = top.current;
    top.current = now;
    if (
      before === undefined ||
      Math.abs(before - now) < 0.5 ||
      typeof element.animate !== "function" ||
      document.documentElement.dataset.motion === "reduced" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    element.animate(
      [{ transform: `translateY(${before - now}px)` }, { transform: "none" }],
      { duration: 220, easing: followEasing },
    );
  });
  return (
    <span
      ref={box}
      className="spark-mark"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="spark-mark-steps" style={{ width: size, height: size }}>
        <Star size={size} />
      </span>
    </span>
  );
}

/** The glide the live page uses when the star follows the text (220ms). */
export const followEasing =
  "linear(0 0%, 0.0477 4.55%, 0.1527 9.09%, 0.2773 13.6%, 0.4009 18.2%, 0.5135 22.7%, 0.611 27.3%, 0.6926 31.8%, 0.7594 36.4%, 0.8131 40.9%, 0.8558 45.5%, 0.8893 50%, 0.9154 57.1%, 0.9356 61.9%, 0.9511 66.7%, 0.963 71.4%, 0.9721 76.2%, 0.979 81%, 0.9842 85.7%, 0.9881 90.5%, 0.9911 95.2%, 1 100%)";
