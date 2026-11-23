import type { Conversation, Item, Turn } from "../../../shared/types";
import { workflowFromTurn } from "../../../shared/workflow-model";

type WorkflowStatus = "completed" | "failed" | "stopped";
type AgentState = "start" | "progress" | "done" | "error";

type WorkflowPhase = { type: "workflow_phase"; index: number; title: string };
type WorkflowAgent = {
  type: "workflow_agent";
  index: number;
  agentId: string;
  label: string;
  state: AgentState;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  startedAt?: number;
  durationMs?: number;
  tokens?: number;
  toolCalls?: number;
  lastToolSummary?: string;
  error?: string;
};

export type CodeWorkflowEvent = {
  uuid: string;
  timestamp?: string;
  task_id: string;
  run_id: string;
  tool_use_id: string;
} & (
  | {
      subtype: "task_started";
      task_type: "local_workflow";
      workflow_name: string;
      description: string;
    }
  | {
      subtype: "task_progress";
      workflow_progress: (WorkflowPhase | WorkflowAgent)[];
    }
  | {
      subtype: "task_notification";
      status: WorkflowStatus;
      summary: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    }
);

function storedText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function storedTime(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function agentState(status: unknown): AgentState | undefined {
  switch (status) {
    case "pendingInit":
      return "start";
    case "running":
      return "progress";
    case "completed":
    case "shutdown":
      return "done";
    case "errored":
    case "interrupted":
      return "error";
  }
}

export function codeWorkflowTranscript({
  conversation,
  turn,
  item,
  toolId,
}: {
  conversation: Conversation;
  turn: Turn;
  item: Item;
  toolId: string;
}): CodeWorkflowEvent[] {
  if (item.type !== "collabAgentToolCall" || item.tool !== "workflow")
    return [];
  const workflow = workflowFromTurn(turn, conversation, [item]);
  const name = storedText(item.workflowName);
  if (!workflow?.runId || !name) return [];

  const ids = {
    task_id: workflow.runId,
    run_id: workflow.runId,
    tool_use_id: toolId,
  };
  const startedAt = storedTime(item.workflowStartedAt);
  const endedAt = storedTime(item.workflowEndedAt);
  const start =
    startedAt === undefined
      ? {}
      : { timestamp: new Date(startedAt).toISOString() };
  const events: CodeWorkflowEvent[] = [
    {
      ...ids,
      ...start,
      uuid: `${toolId}:task_started`,
      subtype: "task_started",
      task_type: "local_workflow",
      workflow_name: name,
      description: storedText(item.workflowDescription) ?? name,
    },
  ];
  const end =
    endedAt === undefined ? {} : { timestamp: new Date(endedAt).toISOString() };
  const phases = new Map<string, WorkflowPhase>();
  const addPhase = (title: string) => {
    const prior = phases.get(title);
    if (prior) return prior;
    const phase: WorkflowPhase = {
      type: "workflow_phase",
      index: phases.size,
      title,
    };
    phases.set(title, phase);
    return phase;
  };
  if (Array.isArray(item.workflowPhases)) {
    for (const value of item.workflowPhases) {
      const title = storedText(value);
      if (title) addPhase(title);
    }
  }
  const agents: WorkflowAgent[] = workflow.agents.flatMap((agent, index) => {
    const recordedStatus = item.agentsStates?.[agent.id]?.status;
    const state = agentState(recordedStatus);
    if (!state) return [];
    const title = storedText(item.agentPhases?.[agent.id]);
    const phase = title ? addPhase(title) : undefined;
    return [
      {
        type: "workflow_agent",
        index,
        agentId: agent.id,
        label: agent.name,
        state,
        ...(phase ? { phaseIndex: phase.index, phaseTitle: phase.title } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.startedAt !== undefined
          ? { startedAt: agent.startedAt }
          : {}),
        ...(agent.durationMs !== undefined
          ? { durationMs: agent.durationMs }
          : {}),
        ...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
        ...(agent.toolUses !== undefined ? { toolCalls: agent.toolUses } : {}),
        ...(agent.currentAction
          ? { lastToolSummary: agent.currentAction }
          : {}),
        ...(state === "error" &&
        agent.message &&
        !(recordedStatus === "interrupted" && workflow.status === "stopped")
          ? { error: agent.message }
          : {}),
      },
    ];
  });

  if (phases.size || agents.length)
    events.push({
      ...ids,
      ...end,
      uuid: `${toolId}:task_progress`,
      subtype: "task_progress",
      workflow_progress: [...phases.values(), ...agents],
    });
  if (workflow.status === "running") return events;
  const usage =
    startedAt !== undefined &&
    endedAt !== undefined &&
    endedAt >= startedAt &&
    workflow.totalTokens !== undefined &&
    workflow.agents.every(
      (agent) => agent.tokens !== undefined && agent.toolUses !== undefined,
    )
      ? {
          total_tokens: workflow.totalTokens,
          tool_uses: workflow.agents.reduce(
            (sum, agent) => sum + (agent.toolUses ?? 0),
            0,
          ),
          duration_ms: endedAt - startedAt,
        }
      : undefined;
  events.push({
    ...ids,
    ...end,
    uuid: `${toolId}:task_notification`,
    subtype: "task_notification",
    status: workflow.status,
    summary: workflow.summary ?? "",
    ...(usage ? { usage } : {}),
  });
  return events;
}
