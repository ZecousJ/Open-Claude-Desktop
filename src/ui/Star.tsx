/*
 * The Claudex mark: the knot of six outlined petals from the app icon
 * (build/icon.svg), drawn alone in the current colour. Its paths live in a
 * 1024 square around (512, 512); the knot spans about 151–873 of it.
 */
export const KNOT_PATHS = [
  "M392 492C282 362 362 182 582 162 632 262 622 402 392 492Z",
  "M469.3 398.1C526.9 237.8 722.8 217.1 850.1 397.6 788.5 490.9 662.3 552.3 469.3 398.1Z",
  "M589.3 418.1C756.9 387.8 872.8 547.1 780.1 747.6 668.5 740.9 552.3 662.3 589.3 418.1Z",
  "M632 532C742 662 662 842 442 862 392 762 402 622 632 532Z",
  "M554.7 625.9C497.1 786.2 301.2 806.9 173.9 626.4 235.5 533.1 361.7 471.7 554.7 625.9Z",
  "M434.7 605.9C267.1 636.2 151.2 476.9 243.9 276.4 355.5 283.1 471.7 361.7 434.7 605.9Z",
] as const;
/** The knot's box in path units, its stroke included. */
const KNOT_SPAN = 784;

/**
 * The knot as SVG content centred on (cx, cy), `size` units across, its
 * strokes `stroke` units wide (the icon's own weight, 40 of 784, unless a
 * small size needs it heavier to stay legible).
 */
export function KnotShape({
  cx,
  cy,
  size,
  stroke,
  inheritColor = false,
}: {
  cx: number;
  cy: number;
  size: number;
  stroke?: number;
  /** Take the stroke colour from the parent's CSS instead of currentColor. */
  inheritColor?: boolean;
}) {
  const scale = size / KNOT_SPAN;
  const width = Math.max(40, (stroke ?? 0) / scale);
  return (
    <g
      transform={`translate(${cx} ${cy}) scale(${scale.toFixed(5)}) translate(-512 -512)`}
      fill="none"
      stroke={inheritColor ? undefined : "currentColor"}
      strokeWidth={width.toFixed(1)}
      strokeLinejoin="round"
    >
      {KNOT_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
}

export function Star({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="120 120 784 784"
      className="star"
      aria-hidden="true"
      focusable="false"
    >
      {/* Never thinner than about 1.4px on screen. */}
      <KnotShape
        cx={512}
        cy={512}
        size={KNOT_SPAN}
        stroke={(1.4 * KNOT_SPAN) / size}
      />
    </svg>
  );
}
