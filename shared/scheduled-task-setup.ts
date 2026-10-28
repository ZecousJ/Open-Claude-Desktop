/** Explicit intent from Scheduled → Create with Claudex; never inferred from prose. */
export interface ScheduledTaskSetupIntent {
  returnTo: "scheduled";
  projectId?: string;
  cwd?: string;
}
/** Creation receipt is written by the owned backend, never accepted from a draft. */
export interface ScheduledTaskSetupState extends ScheduledTaskSetupIntent {
  createdTaskId?: string;
}
