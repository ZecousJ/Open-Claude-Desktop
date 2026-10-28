import { createContext } from "react";

/** The Customize pane owns the top action strip outside its scrolling content. */
export const ConnectorHeaderSlot = createContext<HTMLElement | null>(null);
