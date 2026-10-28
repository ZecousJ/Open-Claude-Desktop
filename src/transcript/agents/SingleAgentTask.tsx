import { BackgroundGlyph } from "../../conversation/background-glyphs";
import { formatText } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import { BoldCount } from "./BoldCount";
import {
  formatWorkflowTime,
  formatWorkflowTokens,
  type WorkflowSummary,
} from "../../../shared/workflow-model";

export function SingleAgentTask({
  task,
  now,
  onStop,
  onView,
  onError,
}: {
  task: WorkflowSummary;
  now: number;
  onStop?: (conversationId: string, ids: string[]) => Promise<void>;
  onView: (conversationId: string, agentId: string, title: string) => void;
  onError: (error: unknown) => void;
}) {
  const agent = task.agents[0],
    running = task.status === "running";
  const elapsed = running ? now - task.startedAt : task.durationMs;
  return (
    <article className="single-agent-task">
      <div className="single-agent-task-title">
        <strong>{task.title}</strong>
        {running && (
          <WithTooltip label="Stop agent">
            {(tooltip) => (
              <button
                {...tooltip}
                aria-label={`Stop ${task.title}`}
                disabled={!onStop}
                onClick={() =>
                  void onStop?.(task.conversationId, [agent.id]).catch(onError)
                }
              >
                <BackgroundGlyph name="Stop" />
              </button>
            )}
          </WithTooltip>
        )}
      </div>
      <div className="single-agent-task-line">
        <b>Agent</b>
        <span>
          {elapsed === undefined ? "—" : formatWorkflowTime(elapsed / 1000)}
        </span>
      </div>
      <div className="single-agent-task-line">
        {agent.model && <b>{agent.model}</b>}
        {agent.tokens !== undefined && (
          <span>
            <BoldCount
              template="{count} tokens"
              count={formatWorkflowTokens(agent.tokens)}
            />
          </span>
        )}
        {agent.toolUses !== undefined && (
          <span>
            <BoldCount
              template={
                agent.toolUses === 1 ? "{count} tool use" : "{count} tool uses"
              }
              count={agent.toolUses}
            />
          </span>
        )}
      </div>
      <div className="single-agent-task-line single-agent-task-footer">
        {running ? (
          <span>{agent.currentAction ?? "Working"}</span>
        ) : (
          // The original's status word.
          <span data-status={task.status}>
            {task.status === "failed"
              ? "Failed"
              : task.status === "stopped"
                ? "Stopped"
                : "Completed"}
          </span>
        )}
        <button
          aria-label={formatText("View transcript for {description}", {
            description: task.title,
          })}
          onClick={() => onView(task.conversationId, agent.id, task.title)}
        >
          View transcript
        </button>
      </div>
    </article>
  );
}
