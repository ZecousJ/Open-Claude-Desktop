import type { DockPanel } from "./useToolPanels";

export type DockLayout = DockPanel[][];
export type PaneEdge = "left" | "right" | "top" | "bottom";

export function reconcileDock(
  layout: DockLayout,
  panels: readonly DockPanel[],
): DockLayout {
  const next = layout
    .map((column) => column.filter((pane) => panels.includes(pane)))
    .filter((column) => column.length);
  for (const pane of panels) {
    if (next.some((column) => column.includes(pane))) continue;
    if (pane === "terminal") next.push([pane]);
    else if (next[0] && !next[0].includes("terminal")) next[0].push(pane);
    else next.unshift([pane]);
  }
  return next;
}

export function paneAtEdge(
  layout: DockLayout,
  pane: DockPanel,
  edge: PaneEdge,
) {
  const column = layout.findIndex((column) => column.includes(pane));
  if (column < 0) return true;
  const row = layout[column].indexOf(pane);
  return edge === "left"
    ? column === 0 && layout[column].length === 1
    : edge === "right"
      ? column === layout.length - 1 && layout[column].length === 1
      : edge === "top"
        ? row === 0
        : row === layout[column].length - 1;
}

/** Move one pane without changing its siblings' order. */
export function moveDockPane(
  layout: DockLayout,
  pane: DockPanel,
  edge: PaneEdge,
): DockLayout {
  if (paneAtEdge(layout, pane, edge)) return layout;
  const column = layout.findIndex((column) => column.includes(pane));
  const next = layout.map((column) => column.filter((value) => value !== pane));
  if (edge === "top") next[column].unshift(pane);
  else if (edge === "bottom") next[column].push(pane);
  else if (edge === "left") next.unshift([pane]);
  else next.push([pane]);
  return next.filter((column) => column.length);
}
