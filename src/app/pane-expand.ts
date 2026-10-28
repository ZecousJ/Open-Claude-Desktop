import { useEffect, useRef } from "react";
import type { DockPanel } from "./useToolPanels";

/** Each dock card's root class (ToolDock finds the cards by it too). */
export const dockCardClass: Record<DockPanel, string> = {
  background: "background-tasks-panel",
  runs: "runs-panel",
  changes: "changes-panel",
  files: "files-panel",
  browser: "browser-panel",
  "ios-simulator": "ios-simulator-panel",
  "android-emulator": "android-emulator-panel",
  terminal: "terminal-panel",
  session: "session-panel",
  pr: "pull-request-panel",
  widget: "widget-panel",
  plan: "plan-panel",
  agent: "agent-transcript-panel",
  artifact: "artifact-panel",
};

/** The dock card an element is in. */
export function dockPanelOf(element: Element | null): DockPanel | undefined {
  const card = element?.closest(".work-panel");
  if (!card) return undefined;
  return (Object.keys(dockCardClass) as DockPanel[])
    .reverse()
    .find((panel) => card.classList.contains(dockCardClass[panel]));
}

const toggles = new Map<DockPanel, () => void>();

/**
 * A card's Expand / Restore, offered to ⇧⌘\. The card keeps its own expanded
 * state.
 */
export function usePaneExpandToggle(panel: DockPanel, toggle: () => void) {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const run = () => latest.current();
    toggles.set(panel, run);
    return () => {
      if (toggles.get(panel) === run) toggles.delete(panel);
    };
  }, [panel]);
}

/**
 * The card ⇧⌘\ acts on: the one holding the keyboard focus, else the
 * dock's focused card (the one last pressed, or opened last).
 */
export function paneToExpand(doc: Document): DockPanel | undefined {
  const own = dockPanelOf(doc.activeElement);
  if (own) return own;
  const focused = doc
    .querySelector(".tool-dock, .code-workspace-layout")
    ?.getAttribute("data-focus");
  return focused && focused in dockCardClass
    ? (focused as DockPanel)
    : undefined;
}

/** ⇧⌘\: expands the card, or restores it; false when no card answers. */
export function toggleExpandPane(doc: Document = document): boolean {
  const panel = paneToExpand(doc);
  const toggle = panel && toggles.get(panel);
  if (!toggle) return false;
  toggle();
  return true;
}

export function arrangePane(
  panel: DockPanel,
  fill: boolean,
  doc: Document = document,
) {
  const card = doc.querySelector(`.work-panel.${dockCardClass[panel]}`);
  if (card && card.classList.contains("expanded") !== fill)
    toggles.get(panel)?.();
}
