import { routineRunLimit, type RoutineRun } from "./routine-labels";

/** Counts known execution records, not skipped dispatches or invented totals.
 * A truncated history is a lower bound; missing legacy history is unknown. */
export function recordedRoutineRunCount(
  runs: readonly RoutineRun[],
  lastRunAt?: number,
) {
  const count = runs.filter((run) => run.status !== "skipped").length;
  if (count === 0 && lastRunAt !== undefined) return {};
  return { runCount: count, runCountLimited: runs.length >= routineRunLimit };
}
