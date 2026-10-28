import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2, X } from "../ui/glyphs";
import type { DockPanel } from "./useToolPanels";
import { dockCardClass, usePaneExpandToggle } from "./pane-expand";
import { t } from "../i18n";
import "./session-panes.css";

export function SessionPaneFrame({
  pane,
  title,
  onClose,
  children,
}: {
  pane: DockPanel;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  usePaneExpandToggle(pane, () => setExpanded((value) => !value));
  return (
    <aside
      className={`work-panel ${dockCardClass[pane]}${expanded ? " expanded" : ""}`}
      aria-label={t(title)}
    >
      <header>
        <strong>{t(title)}</strong>
        <div>
          <button
            aria-label={t(expanded ? "Tile" : "Fill")}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button aria-label={t("Close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      {children}
    </aside>
  );
}
