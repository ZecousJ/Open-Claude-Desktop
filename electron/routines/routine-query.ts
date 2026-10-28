import { routineExecutionMetadata } from "./routine-execution-metadata";
import type { AppContext } from "../app/app-context";
import type {
  Routine,
  RoutineBackend,
  RoutineDetailResult,
  RoutineListResult,
} from "../../shared/routines";

/** No transcript crosses this API. Counts cover every retained real run,
 * plus linked legacy conversations, rather than the last conversation pointer. */
export function queryRoutineList(
  ctx: AppContext,
  backend: RoutineBackend,
): RoutineListResult {
  const conversations = ctx.store.conversations;
  const approvals = ctx.engine?.approvals ?? [];
  const tasks = ctx.scheduler!.list().map((task): Routine => {
    const runs = ctx.scheduler!.runs(task.id);
    const ids = new Set(
      runs.flatMap((run) => (run.conversationId ? [run.conversationId] : [])),
    );
    if (task.conversationId) ids.add(task.conversationId);
    for (const conversation of conversations)
      if (conversation.scheduledTaskId === task.id) ids.add(conversation.id);
    const unreadRuns = runs.filter(
      (run) => run.status === "completed" && !run.readAt,
    );
    const unreadIds = new Set(
      conversations.filter((c) => ids.has(c.id) && c.unread).map((c) => c.id),
    );
    for (const run of unreadRuns)
      if (run.conversationId) unreadIds.add(run.conversationId);
    const failedRuns = runs.filter(
      (run) => run.status === "failed" || run.status === "interrupted",
    );
    const failedIds = new Set(
      failedRuns.flatMap((run) =>
        run.conversationId ? [run.conversationId] : [],
      ),
    );
    for (const conversation of conversations) {
      const status = conversation.turns.at(-1)?.status;
      if (
        ids.has(conversation.id) &&
        (status === "failed" || status === "interrupted")
      )
        failedIds.add(conversation.id);
    }
    return {
      ...task,
      executionLocation: backend,
      listMetadata: {
        ...routineExecutionMetadata(ctx, task, backend),
        attention: {
          unread:
            unreadIds.size +
            unreadRuns.filter((run) => !run.conversationId).length,
          awaiting: approvals.filter((a) => ids.has(a.conversationId)).length,
          failed:
            failedIds.size +
            failedRuns.filter((run) => !run.conversationId).length,
          conversationIds: [...ids],
        },
      },
    };
  });
  return { tasks, sources: [{ source: backend, status: "ready" }] };
}

export function readRoutine(
  ctx: AppContext,
  backend: RoutineBackend,
  id: string,
): RoutineDetailResult {
  const task = queryRoutineList(ctx, backend).tasks.find(
    (task) => task.id === id,
  );
  return task ? { status: "ready", task } : { status: "missing" };
}
