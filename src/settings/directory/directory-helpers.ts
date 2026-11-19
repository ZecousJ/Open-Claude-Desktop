import { currentLocale } from "../../i18n";

/**
 * Helpers the Design systems and Extensions pages share. (Discover's plugins
 * and skills come from the marketplaces and the Claudex directory:
 * src/plugins/plugin-curation.ts.)
 */

/** "Jun 23, 2026". */
export function formatPublished(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Design systems whose name contains the search. */
export function findDesignSystems<T extends { name: string }>(
  list: T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase();
  return words
    ? list.filter((system) => system.name.toLowerCase().includes(words))
    : list;
}

/** Files the original installs by dropping them on the page (R-1450). */
export const extensionFilePattern = /\.(mcpb|dxt)$/i;
