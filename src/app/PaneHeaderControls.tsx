import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "../ui/glyphs";
import type { DockPanel } from "./useToolPanels";
import { dockCardClass, arrangePane } from "./pane-expand";
import { paneAtEdge, type DockLayout, type PaneEdge } from "./dock-layout";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { useApp } from "./AppContext";
import { useHost } from "../host/HostContext";
import { t } from "../i18n";
import { paneHandoffKey, savePaneHandoff } from "./pane-handoff";

const moves = {
  left: "Move to left",
  right: "Move to right",
  top: "Move to top",
  bottom: "Move to bottom",
};

/** Pane header actions. */
export function PaneHeaderControls({
  root,
  layout,
  onMove,
}: {
  root: HTMLDivElement | null;
  layout: DockLayout;
  onMove: (pane: DockPanel, edge: PaneEdge) => void;
}) {
  const app = useApp();
  const host = useHost();
  const [headers, setHeaders] = useState<
    { pane: DockPanel; header: HTMLElement }[]
  >([]);
  const [menu, setMenu] = useState<{
    pane: DockPanel;
    position: MenuPosition;
  }>();
  const panels = layout.flat();
  useEffect(() => {
    if (!root) return;
    const find = () =>
      setHeaders(
        panels.flatMap((pane) => {
          const header = root.querySelector<HTMLElement>(
            `.${dockCardClass[pane]}${pane === "background" ? ":not(.agent-transcript-panel)" : ""} > header`,
          );
          return header ? [{ pane, header }] : [];
        }),
      );
    find();
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(".work-panel, header") ||
                node.querySelector(".work-panel, header")),
          ),
        )
      )
        find();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, panels.join()]);
  const popOut = async (pane: DockPanel) => {
    if (!app.active) return;
    savePaneHandoff(
      localStorage,
      paneHandoffKey(app.accountId, app.active.id, pane),
      {
        sessionId: app.toolPanels.sessionId,
        widgetId: app.toolPanels.widgetId,
        agent: app.toolPanels.agent,
        artifact: pane === "artifact" ? app.artifact : undefined,
      },
    );
    if (host.kind === "desktop")
      await window.desktop.openToolPaneWindow(app.active.id, pane);
    else {
      const url = new URL(location.href);
      url.searchParams.set("window", "conversation");
      url.searchParams.set("id", app.active.id);
      url.searchParams.set("pane", pane);
      window.open(url, "_blank", "noopener");
    }
    if (pane === "artifact") app.setArtifact(undefined);
    app.toolPanels.close(pane);
  };
  const expanded =
    menu &&
    root
      ?.querySelector(`.${dockCardClass[menu.pane]}`)
      ?.classList.contains("expanded");
  const entries: MenuEntry[] = menu
    ? [
        {
          label: "Move",
          submenu: (Object.keys(moves) as PaneEdge[]).map((edge) => ({
            label: moves[edge],
            disabled: paneAtEdge(layout, menu.pane, edge),
            onSelect: () => {
              arrangePane(menu.pane, false);
              onMove(menu.pane, edge);
            },
          })),
        },
        {
          label: "Fill and arrange",
          submenu: [
            {
              label: "Fill",
              checked: Boolean(expanded),
              onSelect: () => arrangePane(menu.pane, true),
            },
            {
              label: "Tile",
              checked: !expanded,
              onSelect: () => arrangePane(menu.pane, false),
            },
          ],
        },
        ...(app.windowRole.kind === "conversation" && app.windowRole.pane
          ? []
          : [
              { separator: true as const },
              {
                label: "Open in new window",
                onSelect: () => void popOut(menu.pane).catch(app.report),
              },
            ]),
      ]
    : [];
  return (
    <>
      {headers.map(({ pane, header }) =>
        createPortal(
          <button
            type="button"
            className="icon-button"
            aria-label={t("Move")}
            aria-haspopup="menu"
            aria-expanded={menu?.pane === pane}
            onClick={(event) =>
              setMenu({
                pane,
                position: event.currentTarget.getBoundingClientRect(),
              })
            }
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>,
          header,
          pane,
        ),
      )}
      {menu && (
        <Menu
          label={t("Move")}
          entries={entries}
          width={176}
          position={menu.position}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
