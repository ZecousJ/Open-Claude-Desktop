import { createContext, useContext } from "react";

/**
 * Which side of the conversation a pane is on: its file tree or file list sits
 * on that outer side when its position is Automatic. The docked panes are
 * always on the right.
 */
export const PaneSideContext = createContext<"left" | "right">("right");
export const usePaneSide = () => useContext(PaneSideContext);
