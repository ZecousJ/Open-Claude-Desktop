import type { CSSProperties } from "react";
import { KNOT_PATHS, KNOT_VIEW_BOX } from "../../shared/knot-mark";
import "./working-knot.css";

/**
 * The working mark: the Claudex knot, its six petals brightening in turn
 * while the whole turns slowly. `kind` sets the pace (what the turn is
 * doing); it stands still under reduced motion.
 */
export function WorkingKnot({
  kind,
  size = 20,
  className,
}: {
  kind: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className ? `clay-mark ${className}` : "clay-mark"}
      data-kind={kind}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <svg
        className="working-knot"
        viewBox={KNOT_VIEW_BOX}
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={72}
        strokeLinejoin="round"
      >
        {KNOT_PATHS.map((d, index) => (
          <path key={d} d={d} style={{ "--petal": index } as CSSProperties} />
        ))}
      </svg>
    </span>
  );
}
