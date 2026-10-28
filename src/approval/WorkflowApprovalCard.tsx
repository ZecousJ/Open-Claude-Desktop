import { Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { ApprovalActions, type ApprovalHandlers } from "./ApprovalActions";

const steps: [string, string][] = [
  [
    "Fan out",
    "Break the task into smaller pieces and run parallel subagents on each",
  ],
  ["Loop", "Keep iterating until the goal is met"],
  ["Verify", "Check the results before reporting back"],
  ["Compose", "Combine everything into the final output"],
];

/**
 * "Allow Claudex to run a dynamic workflow {name}?" before a Workflow tool run:
 * the Agent icon, the question and one line under it, the four steps of a
 * workflow numbered in a box, then Not now and Run workflow.
 */
export function WorkflowApprovalCard({
  name,
  managed = false,
  handlers,
  busy,
  mac,
}: {
  name?: string;
  /** The organization requires approval each time (the note says so). */
  managed?: boolean;
  handlers: ApprovalHandlers;
  busy: boolean;
  mac: boolean;
}) {
  const t = useT();
  const question: ReactNode = name ? (
    <>
      {t("Allow Claudex to")} <b>{t("run a dynamic workflow")}</b>{" "}
      <code data-no-translate>{name}</code>?
    </>
  ) : (
    <>
      {t("Allow Claudex to")} <b>{t("run a dynamic workflow")}</b>?
    </>
  );
  return (
    <section
      className="approval-card approval-request workflow-approval"
      aria-label={t("Run workflow")}
      aria-busy={busy || undefined}
    >
      <div className="workflow-approval-head">
        <span className="workflow-approval-icon" aria-hidden="true">
          <Workflow className="app-icon" size={16} strokeWidth={1.75} />
        </span>
        <div className="workflow-approval-heading">
          <h3 className="approval-title">{question}</h3>
          <p className="workflow-approval-note">
            {managed
              ? t(
                  "Your organization requires approval each time Claudex runs a workflow.",
                )
              : t(
                  "Handle big, complex tasks by splitting up work, looping until done, and verifying the results.",
                )}
          </p>
        </div>
      </div>
      <ol className="workflow-approval-steps">
        {steps.map(([title, detail], index) => (
          <li key={title}>
            <span className="workflow-approval-rail">
              <span className="workflow-approval-number">{index + 1}</span>
              {index < steps.length - 1 && <i />}
            </span>
            <span className="workflow-approval-step">
              <span>{t(title)}</span>
              <small>{t(detail)}</small>
            </span>
          </li>
        ))}
      </ol>
      <ApprovalActions
        handlers={handlers}
        busy={busy}
        mac={mac}
        denyLabel="Not now"
        onceLabel="Run workflow"
      />
    </section>
  );
}
