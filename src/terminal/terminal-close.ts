import type { TerminalSessionInfo } from "../../shared/types";

/**
 * Closing a terminal tab while a command runs in it: Close terminal and Close
 * other terminals first ask which tabs are busy; a tab with a running command
 * is closed only after "Close terminal?" / "Close other terminals?" is
 * confirmed, and one without closes at once. The question goes away by itself
 * when the commands it asks about end, or their tabs are gone.
 */
export type PendingClose =
  | { kind: "close"; id: string }
  | {
      kind: "closeOthers";
      keep: string;
      /** How many of the other tabs had a command running when asked. */
      busyCount: number;
    };

/** What a close needs: the question to ask first, or none (close at once). */
export function closeRequest(
  request:
    { kind: "close"; id: string } | { kind: "closeOthers"; keep: string },
  tabs: Pick<TerminalSessionInfo, "id">[],
  busy: readonly string[],
): PendingClose | undefined {
  if (request.kind === "close")
    return tabs.some((tab) => tab.id === request.id) &&
      busy.includes(request.id)
      ? request
      : undefined;
  if (!tabs.some((tab) => tab.id === request.keep)) return;
  const busyCount = tabs.filter(
    (tab) => tab.id !== request.keep && busy.includes(tab.id),
  ).length;
  return busyCount > 0 ? { ...request, busyCount } : undefined;
}

/** A tab where a command is running, as the window last heard. */
function running(tab: Pick<TerminalSessionInfo, "running" | "busy">) {
  return tab.running && tab.busy === true;
}

/** Whether the question still stands: some tab it asks about is still busy. */
export function stillPending(
  pending: PendingClose,
  tabs: Pick<TerminalSessionInfo, "id" | "running" | "busy">[],
): boolean {
  if (pending.kind === "close")
    return tabs.some((tab) => tab.id === pending.id && running(tab));
  return (
    tabs.some((tab) => tab.id === pending.keep) &&
    tabs.some((tab) => tab.id !== pending.keep && running(tab))
  );
}

/** The ids the window believes are busy, for when the main process can't be asked. */
export function busyTabs(
  tabs: Pick<TerminalSessionInfo, "id" | "running" | "busy">[],
): string[] {
  return tabs.filter(running).map((tab) => tab.id);
}
