import type { Approval, Conversation, Schedule } from "../../shared/types";
import { taskStatus } from "./task-status";

export const tasksPanelLimit = 6;
export type TaskKind = "cowork" | "code" | "dispatch";

export function taskKind(conversation: Conversation): TaskKind {
  return conversation.mode === "code"
    ? "code"
    : conversation.linkedToComputer
      ? "dispatch"
      : "cowork";
}

export function taskSections(
  conversations: Conversation[],
  approvals: readonly Pick<Approval, "conversationId">[],
  schedules: Schedule[],
  filter: ReadonlySet<TaskKind>,
) {
  const waiting = new Set(approvals.map((approval) => approval.conversationId));
  const scheduled = new Set(schedules.map((schedule) => schedule.id));
  const sections: Record<"active" | "attention" | "done", Conversation[]> = {
    active: [],
    attention: [],
    done: [],
  };
  for (const conversation of [...conversations].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  )) {
    if (
      conversation.archived ||
      conversation.incognito ||
      conversation.mode === "chat"
    )
      continue;
    if (filter.size && !filter.has(taskKind(conversation))) continue;
    const status = taskStatus(conversation, waiting.has(conversation.id));
    if (status === "needs_input" || status === "errored")
      sections.attention.push(conversation);
    else if (
      conversation.scheduledTaskId &&
      scheduled.has(conversation.scheduledTaskId)
    )
      continue;
    else if (
      status === "running" ||
      status === "ready_review" ||
      conversation.pullRequests?.some((pullRequest) =>
        ["open", "draft", "queued"].includes(pullRequest.state),
      )
    )
      sections.active.push(conversation);
    else sections.done.push(conversation);
  }
  return sections;
}

export const tasksPanelWidth = (width: number) =>
  Math.min(560, Math.max(240, width));
