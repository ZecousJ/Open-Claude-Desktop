import type { AppContext } from "../app/app-context";
import type { RoutineBrowserState } from "../../shared/routine-browser";
import { routineBrowserAvailable } from "../browser/browser-tools-registration";
/** The native Browser service exists only on the desktop execution host. */
export function routineBrowserPermissions(
  ctx: AppContext,
  id: string,
): RoutineBrowserState {
  const task = ctx.scheduler?.list().find((value) => value.id === id);
  if (!task) throw new Error("This scheduled task no longer exists.");
  if (
    !routineBrowserAvailable(ctx) ||
    task.executionLocation === "remote" ||
    (task.environment && task.environment.kind !== "local") ||
    (task.mode !== "code" && task.mode !== "cowork")
  )
    return {
      status: "unsupported",
      message: "The built-in Browser is unavailable for this scheduled task.",
    };
  return {
    status: "supported",
    readOnly: ctx.scheduler!.browserReadOnly(id),
    grant: ctx.scheduler!.browserGrant(id),
  };
}
export function clearRoutineBrowserPermissions(
  ctx: AppContext,
  id: string,
): void {
  const state = routineBrowserPermissions(ctx, id);
  if (state.status !== "supported") throw new Error(state.message);
  if (state.readOnly) throw new Error("This scheduled task is read-only.");
  ctx.scheduler!.clearBrowserGrant(id);
}
