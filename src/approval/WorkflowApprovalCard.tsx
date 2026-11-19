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
 * "Allow Claudex to run a dynamic workflow {name}?" before a Workflow tool
 * run (live claude.ai bundle, 2026-10-14, ce2992ba3): the Agent icon, the
 * question and one line under it, the four steps of a workflow numbered in
 * a box, then Not now and Run workflow.
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
          {/* The icon font's Agent at sm, 16px (live claude.ai bundle). */}
          <svg
            className="anthropicon"
            width={16}
            height={16}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="m5.19 8.41q-.16-.17-.16-.41q0-.24.16-.41l2.4-2.4q.17-.16.41-.16q.24 0 .41.16l2.4 2.4q.16.17.16.41q0 .24-.16.41l-2.4 2.4q-.17.16-.41.16q-.24 0-.41-.16zm.82-.82l2.4 2.4q-.17-.16-.41-.16q-.24 0-.41.16l2.4-2.4q-.16.17-.16.41q0 .24.16.41l-2.4-2.4q.17.16.41.16q.24 0 .41-.16l-2.4 2.4q.16-.17.16-.41q0-.24-.16-.41zm-.24-3.99q0 .48-.24.89q-.24.4-.65.64q-.4.24-.88.24q-.48 0-.89-.24q-.4-.24-.64-.65q-.24-.4-.24-.88q0-.48.24-.89q.24-.4.65-.64q.4-.24.88-.24q.48 0 .89.24q.4.24.64.65q.24.4.24.88zm-1.14 0q0-.25-.19-.44q-.18-.19-.44-.19q-.25 0-.44.19q-.19.18-.19.44q0 .25.19.44q.18.19.44.19q.25 0 .44-.19q.19-.18.19-.44zm9.14 8.8q0 .48-.24.89q-.24.4-.65.64q-.4.24-.88.24q-.48 0-.89-.24q-.4-.24-.64-.65q-.24-.4-.24-.88q0-.48.24-.89q.24-.4.65-.64q.4-.24.88-.24q.48 0 .89.24q.4.24.64.65q.24.4.24.88zm-1.14 0q0-.25-.19-.44q-.18-.19-.44-.19q-.25 0-.44.19q-.19.18-.19.44q0 .25.19.44q.18.19.44.19q.25 0 .44-.19q.19-.18.19-.44zm-7.03-4.97v1.14h-.59q-.46 0-.83.22q-.36.23-.59.59q-.22.36-.22.81q0 .46.22.83q.23.36.59.59q.37.22.83.22h5.79v1.14h-5.79q-.77 0-1.4-.38q-.63-.37-1-1q-.38-.63-.38-1.4q0-.75.38-1.38q.37-.63 1-1q.63-.38 1.4-.38zm-.4-3.26v-1.14h5.81q.75 0 1.38.38q.63.37 1 1q.38.63.38 1.38q0 .77-.38 1.4q-.37.63-1 1q-.63.38-1.38.38h-.61v-1.14h.61q.44 0 .81-.22q.36-.23.59-.59q.22-.36.22-.83q0-.44-.22-.81q-.23-.36-.59-.59q-.37-.22-.81-.22z" />
          </svg>
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
