import { createContext } from "react";

/** Undefined keeps standalone cards inline; null waits for the home slot to mount. */
export const CodeHomeEnvironmentSlot = createContext<
  HTMLElement | null | undefined
>(undefined);
