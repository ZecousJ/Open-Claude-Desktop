import { Suspense, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MenuPosition } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import { useTooltip } from "../ui/Tooltip";
import { useDismiss } from "../ui/useDismiss";
import { lazyPiece, preloadPiece } from "../ui/lazy-piece";
import type { CodeListView } from "./code-list-view";
import "./code-list.css";

// The trigger paints with the sidebar. Its inventory/recovery UI is needed
// only on interaction; errors stay in the popup rather than moving the header.
const CodeListPopup = lazyPiece(
  () => import("./CodeListPopup"),
  "CodeListPopup",
);
export function CodeListMenu({
  value,
  onChange,
  onNewSection,
  onViewAll,
  classify,
}: {
  value: CodeListView;
  onChange: (view: CodeListView) => void;
  onNewSection: () => void;
  onViewAll: () => void;
  classify: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null),
    frame = useRef<HTMLDivElement>(null),
    loadHost = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition>();
  const tip = useTooltip("Group and sort", { disabled: Boolean(position) });
  const close = () => setPosition(undefined);
  // A pending piece must not open after an outside press. Once it mounts,
  // Menu owns its root and portal submenu dismissal.
  useDismiss([anchor, loadHost], Boolean(position), () => {
    if (!frame.current) close();
  });
  return (
    <>
      <button
        ref={anchor}
        {...tip.props}
        aria-label="Group and sort"
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        className={position ? "open" : undefined}
        onMouseEnter={() => void preloadPiece(CodeListPopup)}
        onKeyDown={(event) => {
          if (
            position &&
            !frame.current &&
            (event.key === "Tab" || event.key === "Escape")
          ) {
            if (event.key === "Escape") event.preventDefault();
            close();
          }
        }}
        onClick={(event) => {
          if (position) return close();
          const r = event.currentTarget.getBoundingClientRect();
          setPosition({ right: innerWidth - r.right, top: r.bottom + 4 });
        }}
      >
        <AppIcon name="Filter" size={16} />
      </button>
      {tip.tooltip}
      {position &&
        createPortal(
          <div
            ref={loadHost}
            style={{
              position: "fixed",
              right: position.right,
              top: Math.max(8, Math.min(position.top ?? 0, innerHeight - 120)),
              width: 200,
              zIndex: 200,
              background: "var(--surface-raised)",
              borderRadius: 12,
            }}
          >
            <Suspense fallback={null}>
              <CodeListPopup
                value={value}
                onChange={onChange}
                onNewSection={onNewSection}
                onViewAll={onViewAll}
                classify={classify}
                position={position}
                anchor={anchor}
                frame={frame}
                onClose={close}
              />
            </Suspense>
          </div>,
          document.body,
        )}
    </>
  );
}
