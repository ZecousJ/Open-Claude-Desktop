import { KNOT_PATHS } from "../../shared/knot-mark";

export { KNOT_PATHS };
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
