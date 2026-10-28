import type { Engine } from "../engine/engine";
import type { Routine } from "../../shared/routines";
import { routineSavedPermission } from "../../shared/routine-labels";
/** Both desktop and runner dispatch the exact saved execution/project identity. */
export function routineSessionInput(
  task: Routine,
  /** Settings tell what a task saved before permission modes runs with. */
  settings?: Parameters<typeof routineSavedPermission>[1],
): Parameters<Engine["send"]>[0] {
  return {
    text: task.prompt,
    mode: task.mode,
    cwd: task.cwd,
    projectId: task.projectId,
    environment: task.environment,
    attachments: [],
    providerId: task.providerId,
    model: task.model,
    scheduledRun: true,
    scheduledTaskId: task.id,
    // The detail page and the editor show this same rule for an old task.
    scheduledPermission:
      task.permission ?? routineSavedPermission(task, settings),
  };
}
