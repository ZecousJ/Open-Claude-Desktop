import { useCallback, useState, type SetStateAction } from "react";
import type {
  AgentPanelTarget,
  SidePanel,
} from "../conversation/ToolSidePanel";
import { surface } from "../../shared/host";
import { deferFileTransition } from "../files/file-transitions";

/**
 * The Code tool cards that open side by side: Background tasks, Changes,
 * Browser and the iOS Simulator and Android Emulator stack in one column, in
 * that order; Terminal is a column of its own on the right. Each opens and
 * closes on its own.
 */
export const dockPanels = [
  "background",
  "runs",
  "session",
  "pr",
  "widget",
  "plan",
  "agent",
  "artifact",
  "changes",
  "files",
  "browser",
  "ios-simulator",
  "android-emulator",
  "terminal",
] as const satisfies readonly SidePanel[];
export type DockPanel = (typeof dockPanels)[number];

export const isDockPanel = (panel: SidePanel | null): panel is DockPanel =>
  !!panel && (dockPanels as readonly string[]).includes(panel);

/** The dock after `panel` opens: kept in the cards' fixed order. */
export const openInDock = (dock: readonly DockPanel[], panel: DockPanel) =>
  dockPanels.filter((p) => p === panel || dock.includes(p));

/**
 * Which tool panels are open beside the conversation. App.tsx keeps this state
 * here and shares the whole result as `useApp().toolPanels`.
 *
 * - `dock` holds the cards that open side by side (see dockPanels).
 * - `single` is any other panel (Progress), which shows alone and closes the
 *   dock.
 * - `panel` / `setPanel` keep their old meaning for hosts and shortcuts:
 *   `panel` is the panel alone or the dock's first card (null with nothing
 *   open); `setPanel(card)` opens a dock card beside the others, any other
 *   panel replaces everything, and `setPanel(null)` closes everything.
 * - `agent` is the child Agent whose transcript the "agent" panel shows.
 */
export function useToolPanels() {
  const [single, setSingle] = useState<SidePanel | null>(null);
  const [dock, setDock] = useState<DockPanel[]>([]);
  const [agent, setAgent] = useState<AgentPanelTarget>();
  const [sessionId, setSessionId] = useState<string>();
  const [widgetId, setWidgetId] = useState<string>();
  const panel: SidePanel | null = single ?? dock[0] ?? null;
  const setPanel = useCallback(
    (next: SetStateAction<SidePanel | null>) => {
      const value = typeof next === "function" ? next(panel) : next;
      if (
        surface !== "web" &&
        (value === null || !isDockPanel(value)) &&
        dock.includes("files") &&
        deferFileTransition(() => setPanel(value), "pane")
      )
        return;
      if (value === null) {
        setSingle(null);
        setDock([]);
      } else if (isDockPanel(value)) {
        setSingle(null);
        setDock((current) => openInDock(current, value));
      } else {
        setSingle(value);
        setDock([]);
      }
    },
    [panel, dock],
  );
  const isOpen = (value: SidePanel) =>
    single === value || (isDockPanel(value) && dock.includes(value));
  const close = (value: SidePanel) => {
    if (
      surface !== "web" &&
      value === "files" &&
      dock.includes("files") &&
      deferFileTransition(() => close(value), "pane")
    )
      return;
    if (single === value) setSingle(null);
    else setDock((current) => current.filter((p) => p !== value));
  };
  return {
    panel,
    setPanel,
    /** Whether a panel is open, alone or in the dock. */
    isOpen,
    /** Closes one panel; the other dock cards stay. */
    close,
    /** Opens a panel, or closes it when it is open. */
    toggle: (value: SidePanel) =>
      isOpen(value) ? close(value) : setPanel(value),
    single,
    dock,
    agent,
    setAgent,
    sessionId,
    setSessionId,
    widgetId,
    setWidgetId,
  };
}
