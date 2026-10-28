import type { RepositoryRef } from "./host";

/**
 * A cloud Code session's start, shown in its transcript while it runs.
 *
 * Claudex's runner clones the repository before the session's sandbox starts,
 * so its order is clone, provision, an optional setup script, start.
 */
export type SetupStepId = "clone" | "provision" | "setup_script" | "start";
export type SetupStepStatus =
  "pending" | "running" | "completed" | "failed" | "skipped";

export interface SetupStep {
  id: SetupStepId;
  status: SetupStepStatus;
  /** What went wrong, in the runner's words (git's, scrubbed of secrets). */
  error?: string;
}

/**
 * Why a start failed, as the transcript names it: "upstream" the repository's
 * host could not be reached (`init_upstream_error`), "failed" anything else
 * (`init_failed`).
 */
export type SetupFailure = "upstream" | "failed";

/** A turn's setup steps (Turn.setup). */
export interface SessionSetup {
  steps: SetupStep[];
  /** How many repositories the clone step fetches. */
  repositories: number;
  failure?: SetupFailure;
}

/**
 * What the runner hands the engine with a new cloud session's first message:
 * the repositories to fetch into the session's (empty) folder, and how. It
 * never comes from a window: only the runner's dispatcher passes one.
 */
export interface SessionSetupHook {
  setupScript?: string;
  repositories: RepositoryRef[];
  fetch(signal: AbortSignal): Promise<void>;
}

/** A failed fetch, with the transcript's name for it. */
export class SetupError extends Error {
  constructor(
    message: string,
    readonly failure: SetupFailure,
  ) {
    super(message);
  }
}

/** The failure an error stands for: a SetupError's own, else "failed". */
export function setupFailureOf(error: unknown): SetupFailure {
  const failure = (error as { failure?: unknown } | null)?.failure;
  return failure === "upstream" ? "upstream" : "failed";
}

/** Whether a value is a setup hook (a window's arguments never hold one). */
export function isSetupHook(value: unknown): value is SessionSetupHook {
  const hook = value as Partial<SessionSetupHook> | null;
  return Boolean(
    hook &&
    typeof hook.fetch === "function" &&
    Array.isArray(hook.repositories) &&
    (hook.repositories.length > 0 || typeof hook.setupScript === "string"),
  );
}

/** A new session's steps: all waiting. */
export function newSessionSetup(
  repositories: number,
  setupScript = false,
): SessionSetup {
  return {
    repositories,
    steps: (
      [
        "clone",
        "provision",
        ...(setupScript ? ["setup_script" as const] : []),
        "start",
      ] as SetupStepId[]
    ).map((id) => ({
      id,
      status: "pending",
    })),
  };
}

/** Sets a step's status (and error); nothing without setup. */
export function markSetupStep(
  setup: SessionSetup | undefined,
  id: SetupStepId,
  status: SetupStepStatus,
  error?: string,
) {
  const step = setup?.steps.find((s) => s.id === id);
  if (!step) return;
  step.status = status;
  if (error) step.error = error;
}

/**
 * The step that was running fails; the ones after it are skipped (the
 * original skips what a failure left undone).
 */
export function failSetup(
  setup: SessionSetup | undefined,
  failure: SetupFailure,
  error?: string,
) {
  if (!setup) return;
  const running = setup.steps.find((s) => s.status === "running");
  if (running) {
    running.status = "failed";
    if (error) running.error = error;
  }
  for (const step of setup.steps)
    if (step.status === "pending") step.status = "skipped";
  setup.failure = failure;
}

/**
 * The steps as a finished turn shows them: what was still running or
 * waiting when the turn ended (stopped, or the app restarted) was skipped.
 */
export function settledSteps(
  setup: SessionSetup,
  turnRunning: boolean,
): SetupStep[] {
  if (turnRunning) return setup.steps;
  return setup.steps.map((step) =>
    step.status === "running" || step.status === "pending"
      ? { ...step, status: "skipped" }
      : step,
  );
}
