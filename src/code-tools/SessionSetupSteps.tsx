import { useEffect, useState } from "react";
import { CircleCheck, CircleX, ChevronRight } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Turn } from "../../shared/types";
import {
  settledSteps,
  type SetupStep,
  type SetupStepStatus,
} from "../../shared/session-setup";
import "./session-setup.css";

type Tense = "done" | "todo" | "doing";

/**
 * A step's tense. The original words a failed step in the past tense; Claudex
 * keeps the plain form so a failed clone never reads as done.
 */
function tense(status: SetupStepStatus): Tense {
  if (status === "completed") return "done";
  if (status === "running") return "doing";
  return "todo";
}

/** A step's words. */
export function setupStepLabel(
  step: Pick<SetupStep, "id" | "status">,
  repositories = 1,
) {
  const when = tense(step.status);
  switch (step.id) {
    case "provision":
      return when === "doing"
        ? "Setting up a cloud container"
        : "Set up a cloud container";
    case "clone":
      if (repositories > 1)
        return when === "done"
          ? `Cloned ${repositories} repositories`
          : when === "todo"
            ? `Clone ${repositories} repositories`
            : `Cloning ${repositories} repositories`;
      return when === "done"
        ? "Cloned repository"
        : when === "todo"
          ? "Clone repository"
          : "Cloning repository";
    case "start":
      return when === "done"
        ? "Started Claudex Code"
        : when === "todo"
          ? "Start Claudex Code"
          : "Starting Claudex Code";
    case "setup_script":
      return when === "done"
        ? "Ran setup script"
        : when === "todo"
          ? "Run setup script"
          : "Running setup script";
  }
}

/**
 * The row's headline (the original's order): a failed step's words, then
 * "Initialized session" once the start is over, then the running step's,
 * then the last step reached, else "Initializing session". Settled steps
 * (`settledSteps`) are expected for a turn that ended.
 */
export function setupHeadline(
  steps: SetupStep[],
  repositories: number,
  running: boolean,
) {
  const failed = steps.find((step) => step.status === "failed");
  if (failed) return setupStepLabel(failed, repositories);
  if (!running) {
    // A start that was stopped (or cut by a restart) never says it is done:
    // it names the first step it did not finish.
    const unfinished = steps.find((step) => step.status !== "completed");
    return unfinished
      ? setupStepLabel(unfinished, repositories)
      : "Initialized session";
  }
  const current = steps.find((step) => step.status === "running");
  if (current) return setupStepLabel(current, repositories);
  const reached = [...steps]
    .reverse()
    .find((step) => step.status !== "pending" && step.status !== "skipped");
  if (reached) return setupStepLabel(reached, repositories);
  return "Initializing session";
}

/** The 14px status mark before a step (Completed, Failed, In progress, …). */
function StepMark({ status }: { status: SetupStepStatus }) {
  const name = {
    completed: "Completed",
    failed: "Failed",
    running: "In progress",
    skipped: "Skipped",
    pending: "Pending",
  }[status];
  return (
    <span className="session-setup-mark" data-status={status}>
      <span className="sr-only">{name}</span>
      {status === "completed" ? (
        <CircleCheck size={12} aria-hidden="true" />
      ) : status === "failed" ? (
        <CircleX size={12} aria-hidden="true" />
      ) : status === "running" ? (
        <Spinner inheritColor size={14} aria-hidden="true" />
      ) : (
        <i aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * A cloud Code session's start in its first turn: one row, "Initializing
 * session" or the step at hand, shimmering while it runs and red when a step
 * failed, whose caret opens the steps with their marks; it opens by itself on a
 * failure. A failed step shows what went wrong under it.
 */
export function SessionSetupSteps({ turn }: { turn: Turn }) {
  const setup = turn.setup;
  const running = turn.status === "inProgress";
  const steps = setup ? settledSteps(setup, running) : [];
  const failed = steps.some((step) => step.status === "failed");
  const [open, setOpen] = useState(failed);
  // A step that fails while the row is shut opens it (the original's).
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);
  if (!setup) return null;
  const headline = setupHeadline(steps, setup.repositories, running);
  return (
    <details
      className="code-command session-setup"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-state={failed ? "failed" : running ? "busy" : "done"}
    >
      <summary>
        <span
          className="code-command-label"
          data-running={(running && !failed) || undefined}
          data-failed={failed || undefined}
        >
          {headline}
        </span>
        <ChevronRight size={16} strokeWidth={1.75} />
      </summary>
      <div className="session-setup-steps">
        {steps.map((step) => (
          <div className="session-setup-step" key={step.id}>
            <div className="session-setup-row">
              <StepMark status={step.status} />
              <span className="session-setup-label" data-status={step.status}>
                {setupStepLabel(step, setup.repositories)}
              </span>
            </div>
            {step.status === "failed" && step.error && (
              <div className="session-setup-error" data-no-translate>
                {step.error}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
