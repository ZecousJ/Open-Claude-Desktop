import type { DeviceConversationSummary } from "../../shared/remote-devices";

/** Sections, not tabs. */
export function dispatchGroups(
  tasks: DeviceConversationSummary[],
  ongoing: ReadonlySet<string> = new Set(),
) {
  const groups: Record<
    "active" | "attention" | "done" | "ongoing",
    DeviceConversationSummary[]
  > = { active: [], attention: [], done: [], ongoing: [] };
  for (const task of tasks) {
    if (task.approvals || task.failed) groups.attention.push(task);
    else if (ongoing.has(task.id)) groups.ongoing.push(task);
    else if (task.running || task.readyReview) groups.active.push(task);
    else groups.done.push(task);
  }
  return groups;
}
