import type { Routine } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";

export interface SessionRuns {
  routine: Routine;
  runs: RoutineRun[];
}

/** Local runs are sessions of the same scheduled task. */
export async function sessionRuns(
  conversationId: string,
  api: {
    listSchedules(): Promise<Routine[]>;
    routineRuns(id: string): Promise<RoutineRun[]>;
  },
): Promise<SessionRuns | undefined> {
  const routines = await api.listSchedules();
  const histories = await Promise.all(
    routines.map(async (routine) => ({
      routine,
      runs: await api.routineRuns(routine.id),
    })),
  );
  return histories.find(({ runs }) =>
    runs.some((run) => run.conversationId === conversationId),
  );
}

export function groupRuns(runs: readonly RoutineRun[]) {
  const sorted = [...runs].sort(
    (left, right) => right.startedAt - left.startedAt,
  );
  const running = (run: RoutineRun) =>
    run.status === "starting" || run.status === "running";
  return {
    running: sorted.filter(running),
    completed: sorted.filter((run) => !running(run)),
  };
}
