import { useState, type CSSProperties } from "react";

/** One sweep of the band, holds at both ends included. */
export const SHIMMER_CYCLE_MS = 3000;

/**
 * Where in its cycle a shimmer starting now should begin: every shimmer
 * runs on the page's clock, so a label that is replaced (new text, a
 * remount) carries on from where the old one was instead of starting over.
 */
export function shimmerDelay(now = shimmerClock()) {
  return -(Math.round(now) % SHIMMER_CYCLE_MS);
}

function shimmerClock() {
  if (typeof document !== "undefined") {
    const time = document.timeline?.currentTime;
    if (typeof time === "number") return time;
  }
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/**
 * Text a highlight crosses while something works: the text keeps its own colour
 * and a copy laid over it, clipped to the glyphs, carries a 120° band that
 * sweeps across in 3s, resting a moment at each end (chat-transcript.css,
 * "Shimmer text"). The copy is hidden from assistive technology and selection.
 */
export function ShimmerText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const [delay] = useState(() => shimmerDelay());
  return (
    <span
      className={className ? `shimmer-text ${className}` : "shimmer-text"}
      style={{ "--shimmer-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
      <span className="shimmer-text-band" aria-hidden="true">
        {children}
      </span>
    </span>
  );
}
