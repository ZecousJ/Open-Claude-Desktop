import type { CSSProperties } from "react";
import handShapes from "./activity-hand-shapes.json";
import "../ui/pictogram.css";

/** Exact HandShapes frames from the 2026-10-16 live source asset
 * c154eb486-DSde-WYt.js. The official flipbook moves each absolute M by
 * twice the view-box width per frame, then advances 60 steps over 5s.
 * This data is imported only with the lazy Activity panel. */
const frames = handShapes.frames.map((frame, index) => {
  const offset = index * 2 * handShapes.width;
  const shift = (path: string) =>
    path.replace(/M(-?\d+)/g, (_, x: string) => `M${Number(x) + offset}`);
  return {
    highlight: frame.highlight.map(shift),
    line: frame.line.map(shift),
  };
});

const animation = {
  "--session-activity-steps": frames.length,
  "--session-activity-span": `${-(frames.length - 1) * 2 * 100}%`,
  animationDuration: `${frames.length / handShapes.frameRate}s`,
  animationPlayState: "running",
  animationIterationCount: 1,
  animationFillMode: "forwards",
} as CSSProperties;

export function ActivityIllustration() {
  return (
    <svg
      className="pictogram session-activity-pictogram"
      width={96}
      height={96}
      viewBox={`0 0 ${handShapes.width} ${handShapes.height}`}
      fill="none"
      aria-hidden="true"
    >
      <g className="session-activity-flipbook" style={animation}>
        {frames.map((frame, index) => (
          <g key={index}>
            {frame.highlight.map((path, index) => (
              <path
                key={`h${index}`}
                className="pictogram-highlight"
                d={path}
              />
            ))}
            {frame.line.map((path, index) => (
              <path key={`l${index}`} fill="currentColor" d={path} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}
