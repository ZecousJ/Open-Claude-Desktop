import { createContext, type ComponentType, type ReactNode } from "react";
import type { DockPanel } from "./useToolPanels";
import type { SidePanel } from "../conversation/ToolSidePanel";

/** Supplied only by the native Code workspace; the legacy hosts keep their dock. */
export const CodeWorkspaceContext = createContext<{
  Tools: ComponentType<{
    panels: DockPanel[];
    card: (panel: SidePanel) => ReactNode;
  }>;
} | null>(null);
