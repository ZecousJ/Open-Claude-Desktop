/**
 * Asks an open search palette to show its Search view (⇧⌘K, Go ▸
 * Search…). A window event, so the always-loaded window need not load the
 * palette to ask.
 */
export const searchViewEvent = "claudex:search-palette-view";

export type SearchEntrypoint = "default" | "search" | "actions";
