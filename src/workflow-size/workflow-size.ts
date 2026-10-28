import type { WorkflowSummary } from "../../shared/workflow-model";

/**
 * When a running workflow is larger than most: more than 25 agents scheduled,
 * or more than 1.5M tokens projected (the tokens so far per started agent, 70k
 * before any started, times the agents scheduled).
 */
export const agentCap = 25;
export const tokenCap = 1_500_000;
const perAgentGuess = 70_000;

export interface SizeWarning {
  axis: "agents" | "tokens" | "both";
  scheduledAgents: number;
  projectedTokens: number;
}

export function workflowSizeWarning(
  workflow: WorkflowSummary,
): SizeWarning | undefined {
  if (workflow.kind !== "workflow" || workflow.status !== "running")
    return undefined;
  const scheduled = workflow.agents.length;
  const started = workflow.agents.filter(
    (agent) => agent.status !== "pendingInit" || (agent.tokens ?? 0) > 0,
  ).length;
  const total = workflow.totalTokens ?? 0;
  const perAgent = started > 0 ? total / started : perAgentGuess;
  const projected = Math.max(total, Math.round(perAgent * scheduled));
  const agents = scheduled > agentCap;
  const tokens = projected > tokenCap;
  if (!agents && !tokens) return undefined;
  return {
    axis: agents && tokens ? "both" : agents ? "agents" : "tokens",
    scheduledAgents: scheduled,
    projectedTokens: projected,
  };
}

/** "1.6M", as the original writes the projection (compact, one decimal). */
export const compactTokens = (value: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
