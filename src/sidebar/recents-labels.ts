import type { Mode } from "../../shared/types";

/**
 * What the lists of past conversations call themselves. Once Chat and Cowork
 * are one home (`hub`: the host can run Cowork, src/home-mode.ts) the sidebar's
 * list and the full list are "Recents", searched with "Search recents..." and
 * started with "New session", as Code's are; a host that cannot run Cowork
 * keeps "Chats and tasks".
 */

/** The sidebar's recents section title. */
export function recentsTitle(_mode: Mode, _hub: boolean) {
  return "Recents";
}

export type HistoryKind = "both" | "chats" | "tasks";

/** The full list's copy. */
export function historyLabels(
  mode: Mode,
  _hub: boolean,
  _kind: HistoryKind = "both",
) {
  if (mode === "code")
    return {
      title: "Sessions",
      searchPlaceholder: "Search sessions",
      searchLabel: "Search sessions",
      newLabel: "New session",
    };
  return {
    title: "Recents",
    searchPlaceholder: "Search recents...",
    searchLabel: "Search your activity",
    newLabel: "New session",
  };
}
