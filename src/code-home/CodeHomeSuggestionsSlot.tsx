import { createContext } from "react";

/** Undefined keeps standalone suggestions inline; null waits for the home slot. */
export const CodeHomeSuggestionsSlot = createContext<
  HTMLElement | null | undefined
>(undefined);
