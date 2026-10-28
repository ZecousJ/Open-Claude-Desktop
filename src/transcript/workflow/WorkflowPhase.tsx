import { useEffect, useRef, useState } from "react";
import { Check } from "../../ui/glyphs";
import { BackgroundGlyph } from "../../conversation/background-glyphs";
import { ShimmerText } from "../../ui/ShimmerText";
import { formatText, t } from "../../i18n";
import { AgentStatusGrid } from "../agents/AgentStatusGrid";
import {
  formatWorkflowTime,
  formatWorkflowTokens,
  type WorkflowAgent,
  type WorkflowPhase as PhaseModel,
} from "../../../shared/workflow-model";

const phaseStatusWords: Record<PhaseModel["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function WorkflowPhase({
  phase,
  startedAt,
  now,
  initiallyOpen,
  workflowRunning = false,
  taskStatus,
  onView,
}: {
  phase: PhaseModel;
  startedAt: number;
  now: number;
  initiallyOpen: boolean;
  /** A planned phase of a running workflow will still start agents. */
  workflowRunning?: boolean;
  /** The workflow's state, for an open phase without agents. */
  taskStatus?: "running" | "completed" | "failed" | "stopped";
  onView?: (agent: WorkflowAgent) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const { name, agents, completed, status } = phase;
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === "queued" && status === "running")
      setOpen(true);
    previousStatus.current = status;
  }, [status]);
  const hasTokens = agents.some((agent) => agent.tokens !== undefined);
  return (
    <div className="workflow-phase" data-state={status}>
      <button
        className="workflow-phase-trigger"
        aria-expanded={open}
        data-open={open || undefined}
        aria-label={
          agents.length
            ? formatText(
                agents.length === 1
                  ? "Phase: {title}, {status}, {done} of {total} agent done"
                  : "Phase: {title}, {status}, {done} of {total} agents done",
                {
                  title: name,
                  status: t(phaseStatusWords[status]),
                  done: completed,
                  total: agents.length,
                },
              )
            : formatText("Phase: {title}, {status}", {
                title: name,
                status: t(phaseStatusWords[status]),
              })
        }
        onClick={() => setOpen((value) => !value)}
      >
        {status === "running" ? (
          <ShimmerText>{name}</ShimmerText>
        ) : (
          <span>{name}</span>
        )}
        {agents.length > 0 && (
          <small>
            {completed}/{agents.length}
          </small>
        )}
        <BackgroundGlyph name="CaretRight" className="workflow-phase-caret" />
        <AgentStatusGrid
          agents={agents}
          moreMayAppear={workflowRunning && !agents.length}
        />
      </button>
      {/* A phase no agent ran in says why. */}
      {open && !agents.length && taskStatus && (
        <p className="workflow-phase-empty">
          {
            {
              running: "No agents have started yet",
              completed: "No agents ran in this phase",
              stopped: "Stopped before any agents started",
              failed: "Failed before any agents started",
            }[taskStatus]
          }
        </p>
      )}
      {open && agents.length > 0 && (
        <div
          className={`workflow-agent-table${hasTokens ? " has-tokens" : ""}`}
        >
          <div className="workflow-agent-heading">
            <span>Agent</span>
            <span>Model</span>
            {hasTokens && <span>Tokens</span>}
            <span>Time</span>
          </div>
          {agents.map((agent) => (
            <WorkflowAgentRow
              key={agent.id}
              agent={agent}
              hasTokens={hasTokens}
              startedAt={startedAt}
              now={now}
              onView={onView}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function WorkflowAgentRow({
  agent,
  hasTokens,
  startedAt,
  now,
  onView,
}: {
  agent: WorkflowAgent;
  hasTokens: boolean;
  startedAt: number;
  now: number;
  onView?: (agent: WorkflowAgent) => void;
}) {
  const duration =
    agent.durationMs !== undefined
      ? formatWorkflowTime(agent.durationMs / 1000)
      : ["running", "pendingInit"].includes(agent.status)
        ? formatWorkflowTime((now - (agent.startedAt ?? startedAt)) / 1000)
        : "—";
  const done = ["completed", "shutdown"].includes(agent.status);
  return (
    <button
      className="workflow-agent-row"
      data-done={done}
      type="button"
      title={`View transcript for ${agent.name}`}
      disabled={!onView}
      onClick={() => onView?.(agent)}
    >
      <span title={agent.message ?? agent.name}>
        {done && <Check size={12} />}
        <span>{agent.name}</span>
      </span>
      <span>{agent.model ?? "—"}</span>
      {hasTokens && (
        <span>
          {agent.tokens === undefined
            ? "—"
            : formatWorkflowTokens(agent.tokens)}
        </span>
      )}
      <span>{duration}</span>
    </button>
  );
}
