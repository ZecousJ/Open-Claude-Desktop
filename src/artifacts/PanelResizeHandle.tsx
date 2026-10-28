import { useRef, useState, type RefObject } from "react";
import { ResizeHandle } from "../ui/ResizeHandle";
import "./file-viewer-panel.css";

const min = 30;
const max = 80;

/**
 * What the original leaves each side of the divider at the W969 window with the
 * sidebar collapsed: dragged narrowest the panel is 321px wide, widest 365px,
 * so the chat column keeps 435px. The same limits hold for the Artifact panel
 * and the file viewer. Widths are kept as a share of the workspace, so the
 * limits become shares of the current workspace. The Artifact panel sits 10px
 * further in than the file viewer (artifact-collaboration.md), hence 341 and
 * 423.
 */
const limitsPx = {
  viewer: { least: 331, chatInset: 433 },
  artifact: { least: 341, chatInset: 423 },
};

export const panelLimits = (collaboration: boolean) =>
  collaboration ? limitsPx.artifact : limitsPx.viewer;

/** The share the divider may take of a workspace this wide. */
function clampShare(value: number, workspace: number, collaboration: boolean) {
  const { least, chatInset } = panelLimits(collaboration);
  const low = Math.min(max, Math.max(min, (least / workspace) * 100));
  const high = Math.max(
    low,
    Math.min(max, ((workspace - chatInset) / workspace) * 100),
  );
  return Math.max(low, Math.min(high, value));
}

/**
 * The panel's left edge: drag or ←/→ to change its share of the workspace.
 * Escape during a drag puts the width back. It draws the shared divider
 * (src/ui/ResizeHandle.tsx).
 */
export function PanelResizeHandle({
  width,
  panel,
  onResize,
}: {
  width: number;
  panel: RefObject<HTMLElement | null>;
  onResize?: (width: number) => void;
}) {
  const drag = useRef<{ start: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const layout = () => {
    const element = panel.current;
    const bounds = element?.closest(".workspace")?.getBoundingClientRect();
    return {
      bounds,
      collaboration:
        element?.classList.contains("artifact-collaboration") ?? false,
    };
  };
  const end = (event: { currentTarget: HTMLElement; pointerId: number }) => {
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <ResizeHandle
      className="file-viewer-resize"
      label="Resize file viewer"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      dragging={dragging}
      // An arrow moves the divider 8px (32px with Shift): the panel's share
      // grows as the divider moves left.
      onStep={(pixels) => {
        const { bounds, collaboration } = layout();
        if (!bounds) return;
        onResize?.(
          clampShare(
            width - (pixels / bounds.width) * 100,
            bounds.width,
            collaboration,
          ),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { start: width };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const { bounds, collaboration } = layout();
        if (bounds)
          onResize?.(
            clampShare(
              ((bounds.right - event.clientX) / bounds.width) * 100,
              bounds.width,
              collaboration,
            ),
          );
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          onResize?.(drag.current.start);
          drag.current = undefined;
          setDragging(false);
        }
      }}
    />
  );
}
