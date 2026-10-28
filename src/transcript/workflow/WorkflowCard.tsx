import { useEffect, useState } from "react";
import { ChevronRight } from "../../ui/glyphs";
import {
  formatWorkflowTime,
  type WorkflowSummary,
} from "../../../shared/workflow-model";
import { AgentStatusGrid } from "../agents/AgentStatusGrid";
import { BoldCount } from "../agents/BoldCount";
import { formatText } from "../../i18n";
export function WorkflowCard({
  workflow,
  onOpen,
}: {
  workflow: WorkflowSummary;
  onOpen: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (workflow.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [workflow.status]);
  const running = workflow.status === "running";
  // Before its first agent the run reads "Starting workflow"; planned phases no
  // agent reached yet will start more.
  const starting = running && workflow.agents.length === 0;
  const moreAgents =
    running && workflow.phases.some((phase) => !phase.agents.length);
  return (
    <button
      className="workflow-card"
      onClick={onOpen}
      aria-label={formatText("View workflow: {description}", {
        description: workflow.title,
      })}
    >
      <span className="workflow-card-title">
        {workflow.title}
        <ChevronRight size={16} />
      </span>
      <span className="workflow-card-meta">
        <b>{starting ? "Starting workflow" : "Workflow"}</b>
        <span>
          <BoldCount
            template={
              workflow.agents.length === 1 ? "{count} agent" : "{count} agents"
            }
            count={workflow.agents.length}
          />
        </span>
        <span>
          {workflow.status === "running"
            ? formatWorkflowTime((now - workflow.startedAt) / 1000)
            : workflow.durationMs === undefined
              ? "—"
              : formatWorkflowTime(workflow.durationMs / 1000)}
        </span>
      </span>
      <AgentStatusGrid
        agents={workflow.agents}
        moreMayAppear={moreAgents || starting}
        wrap
      />
    </button>
  );
}
