import type { CSSProperties } from "react";
import drawing from "./spreadsheet-chart-frames.json";
import "./data-feature-art.css";

/** ObjectSpreadsheetChart flipbook from the owner's readable1014 reference.
 * Same two-viewBox frame spacing as the shared renderer and Activity art. */
const frames = drawing.frames.map((frame, index) => {
  const offset = index * 2 * drawing.width;
  const shift = (path: string) =>
    path.replace(/M(-?\d+)/g, (_, x: string) => `M${Number(x) + offset}`);
  return { highlight: frame.highlight.map(shift), line: frame.line.map(shift) };
});
const animation = {
  "--customize-data-steps": frames.length,
  "--customize-data-span": `${-(frames.length - 1) * 200}%`,
  animationDuration: `${frames.length / drawing.frameRate}s`,
} as CSSProperties;

export function DataFeatureArt() {
  return (
    <span className="customize-data-illustration" aria-hidden="true">
      <svg
        width={128}
        height={128}
        viewBox={`0 0 ${drawing.width} ${drawing.height}`}
        fill="none"
      >
        <g className="customize-data-flipbook" style={animation}>
          {frames.map((frame, index) => (
            <g key={index}>
              {frame.highlight.map((path, i) => (
                <path
                  key={`h${i}`}
                  className="customize-data-highlight"
                  d={path}
                />
              ))}
              {frame.line.map((path, i) => (
                <path key={`l${i}`} fill="currentColor" d={path} />
              ))}
            </g>
          ))}
        </g>
      </svg>
    </span>
  );
}
