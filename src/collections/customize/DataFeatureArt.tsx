import { FileSpreadsheet } from "lucide-react";
import "./data-feature-art.css";

/** The Data feature's picture: a spreadsheet glyph on its disc, 128px. */
export function DataFeatureArt() {
  return (
    <span className="customize-data-illustration" aria-hidden="true">
      <svg width={128} height={128} viewBox="0 0 128 128" fill="none">
        <circle className="customize-data-highlight" cx={64} cy={64} r={52} />
        <FileSpreadsheet
          x={36}
          y={36}
          size={56}
          strokeWidth={1.5}
          color="currentColor"
        />
      </svg>
    </span>
  );
}
