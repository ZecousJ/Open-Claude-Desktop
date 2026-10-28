import { useT } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import { ShimmerText } from "../../ui/ShimmerText";
import type { WorkflowSummary } from "../../../shared/workflow-model";

/**
 * A Workflow tool run that has ended, in the Code transcript: "Ran workflow",
 * its description, then "Stopped" or "Failed" with the reason on hover.
 */
export function WorkflowRunRow({ workflow }: { workflow: WorkflowSummary }) {
  const t = useT();
  const stopped = workflow.status === "stopped";
  const failed = workflow.status === "failed";
  const reason =
    stopped || failed ? workflow.summary || workflow.description : undefined;
  const chip =
    stopped || failed ? (
      <WithTooltip label={reason ?? ""} size="wrap" disabled={!reason}>
        {(props) => (
          <span
            {...props}
            tabIndex={reason ? 0 : undefined}
            className="code-workflow-run-state"
            data-failed={failed || undefined}
          >
            {stopped ? t("Stopped") : t("Failed")}
          </span>
        )}
      </WithTooltip>
    ) : null;
  const running = workflow.status === "running";
  return (
    <div className="code-workflow-run">
      {running ? (
        // While it runs the label shimmers (the original's active shimmer).
        <ShimmerText className="code-command-label">
          {t("Running workflow")}
        </ShimmerText>
      ) : (
        <span className="code-command-label" data-failed={failed || undefined}>
          {t("Ran workflow")}
        </span>
      )}
      {workflow.description && (
        <span className="code-workflow-run-title">{workflow.description}</span>
      )}
      {chip}
    </div>
  );
}
