import { useEffect, useState } from "react";
import { ChevronRight } from "../../ui/glyphs";
import { AgentPriorTool } from "./AgentPriorTool";
import type { Item } from "../../../shared/types";
import {
  formatWorkflowTime,
  type WorkflowSummary,
} from "../../../shared/workflow-model";
import { describeCommand } from "../../code-tools/tool-description-text";
import { formatText } from "../../i18n";

/**
 * An agent row's words: its description, in the past tense once done and as
 * "Failed to …" when it failed; "Running agent", "Ran agent" or "Failed to run
 * agent" when it has none.
 */
export function agentRowLabel(task: Pick<WorkflowSummary, "title" | "status">) {
  const title = task.title.trim();
  const state =
    task.status === "running"
      ? "running"
      : task.status === "failed"
        ? "failed"
        : "completed";
  if (!title)
    return state === "running"
      ? "Running agent"
      : state === "failed"
        ? "Failed to run agent"
        : "Ran agent";
  return describeCommand(title, state);
}

/**
 * Code: the parent conversation shows a background agent as one line, its title
 * and model, that opens the agent. Codex gives the task's own title, so the
 * reference's past tense ("Checked …") is not invented here.
 */
export function CodeAgentRow({
  task,
  onOpen,
}: {
  task: WorkflowSummary;
  onOpen: () => void;
}) {
  const model = task.agents[0]?.model;
  return (
    <button
      type="button"
      className="code-agent-row"
      data-status={task.status}
      onClick={onOpen}
      aria-label={formatText(
        {
          running: "{title}, running. Open the agent",
          completed: "{title}. Open the agent",
          failed: "{title}, failed. Open the agent",
          stopped: "{title}, stopped. Open the agent",
        }[task.status],
        { title: task.title },
      )}
    >
      <span>
        {agentRowLabel(task)}
        {model && ` ${model}`}
      </span>
      <ChevronRight size={16} strokeWidth={1.75} />
    </button>
  );
}

export function SingleAgentEvent({
  task,
  priorTool,
  onOpen,
}: {
  task: WorkflowSummary;
  priorTool?: Item;
  onOpen: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (task.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [task.status]);
  const elapsed =
    task.status === "running" ? now - task.startedAt : task.durationMs;
  return (
    <details className="single-agent-event" open>
      <summary>
        Used a tool <ChevronRight size={15} />
      </summary>
      <div className="single-agent-event-rows">
        {priorTool && <AgentPriorTool item={priorTool} />}
        <button onClick={onOpen}>
          {"Background agent "}
          {task.status === "running"
            ? "started"
            : task.status === "completed"
              ? "completed"
              : task.status === "stopped"
                ? "stopped"
                : "failed"}
          {" · "}
          {task.title}
          {elapsed !== undefined && (
            <> · {formatWorkflowTime(elapsed / 1000)}</>
          )}
        </button>
      </div>
    </details>
  );
}
