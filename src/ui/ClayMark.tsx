import { clayFrames, type ClayMotion } from "./clay-frames";

const fps = 30;
const strips = new Map<ClayMotion, string>();

/** One motion's frames stacked top to bottom, as SVG markup (built once). */
function strip(motion: ClayMotion) {
  let markup = strips.get(motion);
  if (markup) return markup;
  const frames = clayFrames[motion];
  const circles = frames
    .map((frame, index) =>
      frame
        .split(" ")
        .map((dot) => {
          const [x, y, r] = dot.split(",").map(Number);
          return `<circle cx="${x}" cy="${(y + index * 48).toFixed(1)}" r="${r}"/>`;
        })
        .join(""),
    )
    .join("");
  markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 ${frames.length * 48}" fill="currentColor">${circles}</svg>`;
  strips.set(motion, markup);
  return markup;
}

/**
 * The working mark of Chat's status row (live claude.ai, 2026-09-29): three
 * dots stepping through their frames in a 20px square. See clay-frames.ts.
 */
export function ClayMark({ motion = "breathe" }: { motion?: ClayMotion }) {
  const count = clayFrames[motion].length;
  return (
    <span className="clay-mark" data-motion={motion} aria-hidden="true">
      <span
        key={motion}
        className="clay-mark-strip"
        style={{
          height: count * 20,
          animationDuration: `${count / fps}s`,
          animationTimingFunction: `steps(${count})`,
        }}
        dangerouslySetInnerHTML={{ __html: strip(motion) }}
      />
    </span>
  );
}
