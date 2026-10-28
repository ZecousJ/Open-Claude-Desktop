import type { AppContext } from "../app/app-context";
import type { RoutineInput } from "../../shared/routines";
import { routineEnvironment } from "../../shared/routine-environment";
/** A window may choose only its account's project and execution environment. */
export function prepareRoutineInput(
  ctx: AppContext,
  raw: unknown,
): RoutineInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid scheduled task.");
  const input = { ...raw } as RoutineInput;
  const project = input.projectId
    ? ctx.store.projects.find(
        (value) => value.id === input.projectId && !value.archivedAt,
      )
    : undefined;
  if (input.projectId && !project)
    throw new Error("This project is no longer available.");
  const environment = routineEnvironment(
    input.environment ?? project?.environment,
  );
  if (
    environment?.kind === "space" &&
    (project?.environment?.kind !== "space" ||
      project.environment.spaceId !== environment.spaceId)
  )
    throw new Error("This task cannot use that cloud environment.");
  if (
    project &&
    input.mode === "code" &&
    input.cwd === undefined &&
    project.cwd
  )
    input.cwd = project.cwd;
  if (environment) input.environment = environment;
  ctx.allowedFolder(input.cwd, input.environment);
  return input;
}
