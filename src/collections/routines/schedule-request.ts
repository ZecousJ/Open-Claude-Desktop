/**
 * The channel `/schedule` in the composer and a project's "Create new task"
 * use to reach the Routines page. Kept apart from the confirmation card so
 * the composer does not load the card (and the schedule code) with it.
 */
/** What `/schedule <description>` in the Code composer asks to create. */
export interface ScheduleRequest {
  description: string;
  /** Open an empty editor instead of the confirmation (a project's "Create new task"). */
  blank?: boolean;
  describe?: boolean;
  /** Open this saved routine in the editor instead (a project's task row). */
  routineId?: string;
  /** Navigate to a saved task; null opens the list without creating a draft. */
  openRoutineId?: string | null;
  /** The project the new routine is listed under. */
  projectId?: string;
  cwd?: string;
  providerId?: string;
  model?: string;
}

// The request waits here until the Routines page shows it (the App's shared
// state has no slot for it), like open-requests.ts does for projects.
let pending: ScheduleRequest | undefined;
const listeners = new Set<(request: ScheduleRequest) => void>();

/** Asks the Routines page to confirm a routine made from a description. */
export function requestScheduleConfirmation(request: ScheduleRequest) {
  if (listeners.size) for (const listener of listeners) listener(request);
  else pending = request;
}

/** The request waiting for the page, taken once. */
export function takeScheduleRequest() {
  const request = pending;
  pending = undefined;
  return request;
}

/** While mounted, the Routines page shows new requests itself. */
export function onScheduleRequest(
  listener: (request: ScheduleRequest) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
