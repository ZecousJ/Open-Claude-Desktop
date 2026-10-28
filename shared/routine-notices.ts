import type { Schedule } from "./types";
import type { Routine } from "./routines";
import { clip } from "./notice-text";

export function routineCompletionNotices(previous: Routine[], next: Routine[]) {
  const finished = ["completed", "failed", "interrupted"];
  return next.flatMap((task) => {
    const before = previous.find((value) => value.id === task.id);
    if (
      !before ||
      !task.lastRunStatus ||
      !finished.includes(task.lastRunStatus) ||
      !before.lastRunStatus ||
      finished.includes(before.lastRunStatus) ||
      task.lastRunNotify === false ||
      task.notifyOnCompletion?.push === false
    )
      return [];
    return [
      {
        title:
          task.lastRunStatus === "completed"
            ? "Scheduled task completed"
            : "Scheduled task failed",
        body: task.lastRunSummary || clip(task.name, 80) || "Scheduled task",
        conversationId: task.conversationId,
        taskId: task.id,
      },
    ];
  });
}

/**
 * The scheduled task whose run is working in the conversation now, if one
 * is: its requests are told as the task's.
 */
export function runningSchedule(schedules: Schedule[], conversationId: string) {
  return schedules.find(
    (task) =>
      task.conversationId === conversationId &&
      ["starting", "running"].includes(task.lastRunStatus ?? ""),
  );
}
