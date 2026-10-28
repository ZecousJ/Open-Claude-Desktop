import { useSyncExternalStore } from "react";
import type { Conversation, Turn } from "../../shared/types";

/**
 * Usage reports posted in a Code session's transcript: the context popover's
 * "See detailed breakdown", the Usage panel's See breakdown and /usage add a
 * "/usage" prompt and the usage report under the session's latest turn. As in
 * the live app they are the window's own rows: nothing is sent to the model or
 * kept with the conversation, and they are gone after a reload.
 */
export interface PostedUsageReport {
  id: string;
  /** "usage" (/usage) or "status" (/status: the Session info card). */
  kind?: "usage" | "status";
  /** The turn the report follows; null before the session's first turn. */
  afterTurnId: string | null;
  at: number;
}

const none: PostedUsageReport[] = [];
const posted = new Map<string, PostedUsageReport[]>();
const listeners = new Set<() => void>();
let serial = 0;

/** Posts a usage report under the conversation's latest turn. */
export function postUsageReport(
  conversation: Pick<Conversation, "id" | "turns">,
  now = Date.now(),
  kind: "usage" | "status" = "usage",
) {
  const report: PostedUsageReport = {
    id: `${kind === "status" ? "status" : "usage"}-report-${++serial}`,
    kind,
    afterTurnId: conversation.turns.at(-1)?.id ?? null,
    at: now,
  };
  posted.set(conversation.id, [...(posted.get(conversation.id) ?? []), report]);
  for (const listener of listeners) listener();
  return report;
}

export function usageReports(conversationId: string) {
  return posted.get(conversationId) ?? none;
}

/** The reports posted in a conversation, re-rendering when one is added. */
export function useUsageReports(conversationId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => usageReports(conversationId),
    () => usageReports(conversationId),
  );
}

/**
 * The reports shown after a turn (`turnId`), or before the first turn
 * (null). A report whose turn is no longer in the transcript (a rewind set
 * it aside) is shown after the last turn.
 */
export function reportsAfter(
  reports: PostedUsageReport[],
  turnId: string | null,
  turns: Pick<Turn, "id">[],
) {
  if (!reports.length) return none;
  const last = turns.at(-1)?.id ?? null;
  return reports.filter(
    (report) =>
      report.afterTurnId === turnId ||
      (turnId === last &&
        report.afterTurnId !== null &&
        !turns.some((turn) => turn.id === report.afterTurnId)),
  );
}

/** Tests start empty. */
export function clearUsageReports() {
  posted.clear();
  for (const listener of listeners) listener();
}
