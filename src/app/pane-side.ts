import { createContext, useContext } from "react";

/**
 * Which side of the conversation a pane is on: its file tree or file list
 * sits on that outer side when its position is Automatic (live claude.ai
 * bundle, 2026-10-21, cf3dc7910: the "nifty pudding" setting). The docked
 * panes are always on the right.
 */
export const PaneSideContext = createContext<"left" | "right">("right");
export const usePaneSide = () => useContext(PaneSideContext);
