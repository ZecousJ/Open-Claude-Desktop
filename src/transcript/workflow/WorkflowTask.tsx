import { useState } from "react";
import { WorkflowPhase } from "./WorkflowPhase";
import { BackgroundGlyph } from "../../conversation/background-glyphs";
import { ShimmerText } from "../../ui/ShimmerText";
import { t } from "../../i18n";
import { AgentStatusGrid } from "../agents/AgentStatusGrid";
import { BoldCount } from "../agents/BoldCount";
import { WithTooltip } from "../../ui/Tooltip";
import {
  formatWorkflowTime,
  formatWorkflowTokens,
  type WorkflowSummary,
} from "../../../shared/workflow-model";

export function WorkflowTask({
  workflow,
  now,
  onStop,
  onStopRun,
  onView,
  onError,
}: {
  workflow: WorkflowSummary;
  now: number;
  onStop?: (conversationId: string, agentIds: string[]) => Promise<void>;
  /** A Workflow tool run stops as a whole (its script stops starting agents). */
  onStopRun?: (conversationId: string, runId: string) => Promise<void>;
  onView?: (conversationId: string, agentId: string, title: string) => void;
  onError: (error: unknown) => void;
}) {
  const running = workflow.status === "running";
  const [stopping, setStopping] = useState(false);
  const runningIds = workflow.agents
    .filter((agent) => ["running", "pendingInit"].includes(agent.status))
    .map((agent) => agent.id);
  // Planned phases no agent has reached yet will start more agents.
  const moreAgents =
    running && workflow.phases.some((phase) => !phase.agents.length);
  const elapsed = running
    ? formatWorkflowTime((now - workflow.startedAt) / 1000)
    : workflow.durationMs === undefined
      ? "—"
      : formatWorkflowTime(workflow.durationMs / 1000);
  return (
    <article className="background-task">
      <div className="background-task-title">
        {/* The title shimmers while the workflow runs. */}
        {running ? (
          <ShimmerText className="background-task-name">
            {workflow.title}
          </ShimmerText>
        ) : (
          <strong>{workflow.title}</strong>
        )}
        {running && (
          <WithTooltip
            label={stopping ? t("Stopping…") : t("Stop this workflow")}
          >
            {(tooltip) => (
              <button
                {...tooltip}
                className="background-stop"
                aria-label={stopping ? t("Stopping…") : t("Stop this workflow")}
                aria-busy={stopping || undefined}
                disabled={
                  stopping ||
                  (workflow.runId ? !onStopRun : !onStop || !runningIds.length)
                }
                onClick={() => {
                  setStopping(true);
                  void (
                    workflow.runId
                      ? onStopRun?.(workflow.conversationId, workflow.runId)
                      : onStop?.(workflow.conversationId, runningIds)
                  )
                    ?.catch(onError)
                    .finally(() => setStopping(false));
                }}
              >
                <BackgroundGlyph name="Stop" />
              </button>
            )}
          </WithTooltip>
        )}
      </div>
      <div className="background-task-meta">
        <b>Workflow</b>
        {running ? (
          stopping && <span>{t("Stopping…")}</span>
        ) : (
          <span data-status={workflow.status}>
            {t(
              workflow.status === "failed"
                ? "Failed"
                : workflow.status === "stopped"
                  ? "Stopped"
                  : "Completed",
            )}
          </span>
        )}
        <span>{elapsed}</span>
      </div>
      <div className="background-task-meta">
        <span>
          <BoldCount
            template={
              workflow.agents.length === 1 ? "{count} agent" : "{count} agents"
            }
            count={workflow.agents.length}
          />
        </span>
        {workflow.totalTokens !== undefined && (
          <span>
            <BoldCount
              template="{count} tokens"
              count={formatWorkflowTokens(workflow.totalTokens)}
            />
          </span>
        )}
        <AgentStatusGrid
          agents={workflow.agents}
          moreMayAppear={moreAgents}
          wrap
        />
      </div>
      {workflow.description && <p>{workflow.description}</p>}
      {/* A failed or stopped run says why in a box (the original's summary box). */}
      {(workflow.status === "failed" || workflow.status === "stopped") &&
        workflow.summary && (
          <div
            className="background-task-summary"
            data-status={workflow.status}
          >
            {workflow.summary}
          </div>
        )}
      <h3>Phases</h3>
      {workflow.phases.map((phase) => (
        <WorkflowPhase
          key={`${workflow.id}:${phase.name}`}
          phase={
            phase.name === "Agents" && workflow.phases.length > 1
              ? { ...phase, name: "Other agents" }
              : phase
          }
          startedAt={workflow.startedAt}
          now={now}
          initiallyOpen={phase.status !== "queued"}
          workflowRunning={running}
          taskStatus={workflow.status}
          onView={
            onView
              ? (agent) => onView(workflow.conversationId, agent.id, agent.name)
              : undefined
          }
        />
      ))}
    </article>
  );
}
