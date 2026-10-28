import { useSyncExternalStore } from "react";

/** The web's phone width: below 640 CSS px. */
export const phoneQuery = "(max-width: 639.98px)";

const media = (query: string) =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined
    : window.matchMedia(query);

/**
 * Whether a media query matches, kept current as the window changes. False
 * where there is no window (server rendering, tests).
 */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (change) => {
      const list = media(query);
      list?.addEventListener("change", change);
      return () => list?.removeEventListener("change", change);
    },
    () => media(query)?.matches ?? false,
    () => false,
  );
}
