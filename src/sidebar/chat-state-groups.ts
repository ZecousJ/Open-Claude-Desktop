import type { Conversation } from "../../shared/types";

/** O16 shared-22 Di/LU: ordinary Chat uses QJ(liveStatus, unread), whereas
 * agent tasks can additionally have completed work. No Code classifier or
 * default `done` is applied to an ordinary saved Chat. */
export type ChatGroupState = "blocked" | "working" | "ready" | "done" | "idle";
export const chatGroupStateOrder: ChatGroupState[] = [
  "blocked",
  "working",
  "ready",
  "done",
  "idle",
];
export const chatGroupStateLabels: Record<ChatGroupState, string> = {
  blocked: "Needs input",
  working: "Working",
  ready: "Ready",
  done: "Completed",
  idle: "Idle",
};
export function chatGroupState(
  conversation: Conversation,
  approvals: ReadonlySet<string>,
): ChatGroupState {
  const task = conversation.mode === "cowork";
  const hasCompleted =
    task && conversation.turns.some((turn) => turn.status === "completed");
  if (conversation.archived) return hasCompleted ? "done" : "idle";
  if (
    approvals.has(conversation.id) ||
    (task && conversation.turns.at(-1)?.status === "failed")
  )
    return "blocked";
  if (conversation.turns.some((turn) => turn.status === "inProgress"))
    return "working";
  if (conversation.unread && (!task || hasCompleted)) return "ready";
  return hasCompleted ? "done" : "idle";
}
