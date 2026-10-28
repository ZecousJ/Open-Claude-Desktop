/** Facts read on the task's execution host, never a renderer-supplied path. */
export interface RoutineWorkspaceDiagnostics {
  taskId: string;
  host: "local" | "ssh" | "space";
  canReconnect?: boolean;
  folders: {
    path: string;
    state:
      | "ready"
      | "missing"
      | "permission-required"
      | "unavailable"
      | "not-checked";
    message?: string;
  }[];
  problems: ("too-many" | "duplicate" | "unsupported")[];
}

export const routineWorkspaceMessages = {
  missing:
    "This folder no longer exists. Edit the task to choose another folder.",
  permission: "This task needs permission to use this folder.",
  unavailable: "Couldn’t check this folder on its execution host. Try again.",
  tooMany:
    "This task has more than 16 folders. Edit the task to choose fewer folders.",
  duplicate:
    "This task has duplicate folders. Edit the task to remove duplicates.",
  unsupported:
    "This task contains a folder that isn’t supported on its execution host.",
} as const;
