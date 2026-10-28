import { PreviewGlyph } from "./preview-glyphs";

/**
 * A new tab: a globe, "Browse with Claude", what the browser is for, and, where
 * dev servers can run, "Preview your app instead? Detect dev server". Without
 * Browser tools (Settings or the administrator) Claude cannot use the page, so
 * the title is "Browse the web" and the line only asks for a URL. Laid out
 * like the original's start page: Globe at xl in text-disabled, the title in
 * body primary (36ch) and the line in footnote muted (44ch) 4px under it, the
 * prompt in footnote muted with a ghost xxs button 3px after it, 12px apart and
 * 12px in.
 */
export function BrowserEmptyState({
  toolsAvailable,
  onDetect,
  detecting = false,
}: {
  toolsAvailable: boolean;
  /** Absent when dev servers are not available here. */
  onDetect?: () => void;
  detecting?: boolean;
}) {
  return (
    <div className="preview-start" role="status">
      <div className="preview-start-inner">
        <PreviewGlyph name="GlobeXl" className="preview-disabled-icon" />
        <div className="preview-start-text">
          <p className="preview-start-title">
            {toolsAvailable ? "Browse with Claudex" : "Browse the web"}
          </p>
          <p className="preview-start-body">
            {toolsAvailable
              ? "Type a URL or ask Claudex to open a site. Claudex can read, click, and type."
              : "Type a URL to open a site."}
          </p>
        </div>
        {onDetect && (
          <p className="preview-start-detect">
            <span>Preview your app instead?</span>
            <button
              type="button"
              className="preview-button ghost xxs"
              disabled={detecting}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onDetect}
            >
              Detect dev server
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
