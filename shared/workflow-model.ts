import type { Conversation, Item, Turn } from "./types";
import { agentThreadIds } from "./workflow-usage";
import { alignWorkflowPhaseNames } from "./workflow-phase-alignment";

export interface WorkflowAgent {
  id: string;
  name: string;
  phase: string;
  model?: string;
  status: string;
  message?: string;
  tokens?: number;
  toolUses?: number;
  currentAction?: string;
  startedAt?: number;
  durationMs?: number;
}
export interface WorkflowPhase {
  name: string;
  agents: WorkflowAgent[];
  completed: number;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
}
export interface WorkflowSummary {
  id: string;
  /** A Workflow tool run's id (electron/workflows): Stop stops the whole run. */
  runId?: string;
  kind: "agent" | "workflow";
  conversationId: string;
  title: string;
  description: string;
  startedAt: number;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "stopped";
  /** Why a Workflow tool run failed or stopped. */
  summary?: string;
  agents: WorkflowAgent[];
  phases: WorkflowPhase[];
  totalTokens?: number;
}
const collabTypes = new Set(["collabAgentToolCall", "subAgentActivity"]);
const runningStatuses = new Set(["pendingInit", "running"]);
const completedStatuses = new Set(["completed", "shutdown"]);
export function isWorkflowItem(item: Item) {
  return collabTypes.has(item.type);
}
function phaseFor(name: string) {
  const prefix = name.includes(":") ? name.split(":", 1)[0] : "Agents";
  return prefix === "Agents"
    ? "Agents"
    : prefix.charAt(0).toUpperCase() + prefix.slice(1);
}
function nameFor(path: string, id: string) {
  return path.split("/").filter(Boolean).at(-1) ?? id.slice(0, 12);
}
export function formatWorkflowTokens(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value);
}
export function formatWorkflowTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60
    ? `${s}s`
    : s >= 3600
      ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
/** Longest phase label kept from native or workflow metadata. */
const maxPhaseLength = 80;
/** Most planned phases shown for one workflow. */
const maxPlannedPhases = 12;

function trimmedPhase(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxPhaseLength)
    : undefined;
}
function agentFor(agents: Map<string, WorkflowAgent>, id: string) {
  let agent = agents.get(id);
  if (!agent) {
    agent = { id, name: id.slice(0, 12), phase: "Agents", status: "running" };
    agents.set(id, agent);
  }
  return agent;
}
/** Copies per-child counters that native events report keyed by child thread ID. */
function mergeAgentMetrics(agent: WorkflowAgent, item: Item, id: string) {
  const tokens = item.agentTokenUsage?.[id];
  if (Number.isSafeInteger(tokens) && tokens >= 0)
    agent.tokens = Math.max(agent.tokens ?? 0, tokens);
  const startedAt = item.agentStartedAt?.[id];
  if (Number.isFinite(startedAt) && startedAt > 0) agent.startedAt = startedAt;
  const durationMs = item.agentDurationMs?.[id];
  if (Number.isFinite(durationMs) && durationMs >= 0)
    agent.durationMs = durationMs;
  const toolUses = item.agentToolUses?.[id];
  if (Number.isSafeInteger(toolUses) && toolUses >= 0)
    agent.toolUses = toolUses;
  const currentAction = item.agentCurrentAction?.[id];
  if (typeof currentAction === "string") agent.currentAction = currentAction;
}
function applyCollabToolCall(agents: Map<string, WorkflowAgent>, item: Item) {
  for (const id of agentThreadIds(item)) {
    const agent = agentFor(agents, id);
    if (typeof item.model === "string" && item.model) agent.model = item.model;
    // A Workflow tool run names each agent and its model (electron/workflows).
    const name = item.agentNames?.[id];
    if (typeof name === "string" && name.trim())
      agent.name = name.trim().slice(0, 80);
    const model = item.agentModels?.[id];
    if (typeof model === "string" && model) agent.model = model;
    const phase = trimmedPhase(item.agentPhases?.[id]);
    if (phase) agent.phase = phase;
    mergeAgentMetrics(agent, item, id);
  }
  if (!item.agentsStates || typeof item.agentsStates !== "object") return;
  for (const [id, value] of Object.entries(item.agentsStates)) {
    const state =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const agent = agentFor(agents, id);
    if (typeof state.status === "string") agent.status = state.status;
    if (typeof state.message === "string") agent.message = state.message;
  }
}
function applySubAgentActivity(
  agents: Map<string, WorkflowAgent>,
  item: Item,
  conversation: Conversation,
) {
  if (typeof item.agentThreadId !== "string") return;
  const id = item.agentThreadId;
  const agent = agentFor(agents, id);
  if (typeof item.agentPath === "string" && item.agentPath) {
    agent.name = nameFor(item.agentPath, id);
    if (agent.phase === "Agents") agent.phase = phaseFor(agent.name);
  }
  const phase = trimmedPhase(item.workflowPhase);
  if (phase) agent.phase = phase;
  agent.model =
    typeof item.agentModel === "string"
      ? item.agentModel
      : (agent.model ?? conversation.model);
  const state = item.agentsStates?.[id];
  if (typeof state?.status === "string") agent.status = state.status;
  else if (item.kind === "interrupted") agent.status = "interrupted";
  mergeAgentMetrics(agent, item, id);
}
/** Explicit phase names from the spawning call, in order and without duplicates. */
function plannedPhases(spawn: Item | undefined): string[] {
  if (!Array.isArray(spawn?.workflowPhases)) return [];
  const names = spawn.workflowPhases
    .filter(
      (name: unknown): name is string =>
        typeof name === "string" && name.trim().length > 0,
    )
    .slice(0, maxPlannedPhases);
  return [...new Set<string>(names)];
}
function phaseStatus(agents: WorkflowAgent[]): WorkflowPhase["status"] {
  if (!agents.length) return "queued";
  if (agents.some((agent) => runningStatuses.has(agent.status)))
    return "running";
  if (agents.some((agent) => agent.status === "errored")) return "failed";
  if (agents.some((agent) => agent.status === "interrupted")) return "stopped";
  return "completed";
}
/**
 * The parent turn's outcome overrides its children. While the turn is still
 * running, a planned phase that no child has reached keeps the task running.
 */
function taskStatus(
  turn: Turn,
  agents: WorkflowAgent[],
  awaitingPlannedPhase: boolean,
): WorkflowSummary["status"] {
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted") return "stopped";
  const statuses = agents.map((agent) => agent.status);
  if (statuses.some((value) => runningStatuses.has(value))) return "running";
  if (turn.status === "inProgress" && awaitingPlannedPhase) return "running";
  if (statuses.includes("errored")) return "failed";
  if (statuses.includes("interrupted")) return "stopped";
  if (statuses.length) return "completed";
  return turn.status === "completed" ? "completed" : "running";
}
function taskTitle(
  spawn: Item | undefined,
  kind: WorkflowSummary["kind"],
  prompt: string,
  agents: WorkflowAgent[],
  conversation: Conversation,
) {
  if (typeof spawn?.workflowName === "string" && spawn.workflowName.trim())
    return spawn.workflowName.trim();
  if (kind === "workflow") return conversation.title || "Agent workflow";
  const agentName = agents[0]?.name
    .replace(/[-_]/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
  return prompt.split("\n")[0] || agentName || conversation.title;
}
/**
 * Normalizes each agent's phase name, then groups agents by phase. Planned
 * phases come first and stay listed even before any child reaches them.
 */
function groupPhases(
  agents: WorkflowAgent[],
  planned: string[],
): Map<string, WorkflowAgent[]> {
  if (agents.length === 1 && agents[0].phase === "Agents")
    agents[0].phase = "Agent";
  const observed = [...new Set(agents.map((agent) => agent.phase))];
  const aligned = alignWorkflowPhaseNames(planned, observed);
  const byPhase = new Map<string, WorkflowAgent[]>(
    planned.map((name) => [name, []]),
  );
  for (const agent of agents) {
    agent.phase = aligned.get(agent.phase) ?? agent.phase;
    byPhase.set(agent.phase, [...(byPhase.get(agent.phase) ?? []), agent]);
  }
  return byPhase;
}
/** The Workflow tool's run status (electron/workflows) on its item. */
function runStatus(
  item: Item | undefined,
): WorkflowSummary["status"] | undefined {
  if (typeof item?.workflowRunId !== "string") return;
  const status = item.workflowStatus ?? item.status;
  return status === "completed"
    ? "completed"
    : status === "failed"
      ? "failed"
      : status === "interrupted"
        ? "stopped"
        : "running";
}
export function workflowFromTurn(
  turn: Turn,
  conversation: Conversation,
  only?: Item[],
): WorkflowSummary | undefined {
  const items = only ?? turn.items.filter(isWorkflowItem);
  if (!items.length) return;
  const spawn =
    items.find(
      (item) =>
        item.type === "collabAgentToolCall" && item.tool === "spawnAgent",
    ) ?? items.find((item) => item.type === "collabAgentToolCall");

  const agentsById = new Map<string, WorkflowAgent>();
  for (const item of items) {
    if (item.type === "collabAgentToolCall")
      applyCollabToolCall(agentsById, item);
    else applySubAgentActivity(agentsById, item, conversation);
  }
  const agents = [...agentsById.values()];

  const planned = plannedPhases(spawn);
  const byPhase = groupPhases(agents, planned);
  const phases: WorkflowPhase[] = [...byPhase].map(([name, members]) => ({
    name,
    agents: members,
    completed: members.filter((agent) => completedStatuses.has(agent.status))
      .length,
    status: phaseStatus(members),
  }));
  const awaitingPlannedPhase = planned.some(
    (name) => !byPhase.get(name)?.length,
  );
  const status =
    runStatus(spawn) ?? taskStatus(turn, agents, awaitingPlannedPhase);

  const kind: WorkflowSummary["kind"] =
    agents.length === 1 && !planned.length ? "agent" : "workflow";
  const prompt = typeof spawn?.prompt === "string" ? spawn.prompt.trim() : "";
  const description = (prompt || (spawn ? "" : turn.prompt.trim())).split(
    "\n",
  )[0];
  const title = taskTitle(spawn, kind, prompt, agents, conversation);

  const knownTokens = agents.filter((agent) => agent.tokens !== undefined);
  const totalTokens = knownTokens.length
    ? knownTokens.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0)
    : undefined;
  const runStartedAt =
    typeof spawn?.workflowStartedAt === "number"
      ? spawn.workflowStartedAt
      : undefined;
  const startedAt =
    kind === "agent"
      ? (agents[0]?.startedAt ?? turn.createdAt)
      : (runStartedAt ?? turn.createdAt);
  // Only finished tasks report a duration, and only from measured child end times.
  const measuredEnds = agents.flatMap((agent) =>
    agent.durationMs !== undefined
      ? [(agent.startedAt ?? turn.createdAt) + agent.durationMs]
      : [],
  );
  const runEndedAt =
    typeof spawn?.workflowEndedAt === "number"
      ? spawn.workflowEndedAt
      : undefined;
  const durationMs =
    status === "running"
      ? undefined
      : runEndedAt !== undefined
        ? Math.max(0, runEndedAt - startedAt)
        : measuredEnds.length
          ? Math.max(0, Math.max(...measuredEnds) - startedAt)
          : undefined;
  const runId =
    typeof spawn?.workflowRunId === "string" ? spawn.workflowRunId : undefined;
  return {
    id: `${conversation.id}:${turn.id}${only && runId ? `:${runId}` : ""}`,
    ...(runId ? { runId } : {}),
    ...(typeof spawn?.workflowError === "string" && spawn.workflowError
      ? { summary: spawn.workflowError.slice(0, 400) }
      : {}),
    kind,
    conversationId: conversation.id,
    title: title.slice(0, 80),
    description: description.slice(0, 240),
    startedAt,
    durationMs,
    status,
    agents,
    phases,
    totalTokens,
  };
}
/**
 * Explicit workflow metadata groups a turn's children into one Workflow task.
 * Otherwise every spawned child is its own Agent task.
 */
export function tasksFromTurn(
  turn: Turn,
  conversation: Conversation,
): WorkflowSummary[] {
  const items = turn.items.filter(isWorkflowItem);
  if (!items.length) return [];
  // Each Workflow tool run is its own task (a turn can run several).
  const runs = items.filter((item) => typeof item.workflowRunId === "string");
  if (runs.length)
    return [
      ...runs.flatMap((item) => {
        const run = workflowFromTurn(turn, conversation, [item]);
        return run ? [{ ...run, kind: "workflow" as const }] : [];
      }),
      ...tasksFromTurn(
        { ...turn, items: turn.items.filter((item) => !runs.includes(item)) },
        conversation,
      ),
    ];
  const explicitWorkflow = items.some(
    (item) =>
      (Array.isArray(item.workflowPhases) && item.workflowPhases.length > 0) ||
      (typeof item.workflowName === "string" && item.workflowName.trim()),
  );
  if (explicitWorkflow) {
    const workflow = workflowFromTurn(turn, conversation);
    return workflow ? [{ ...workflow, kind: "workflow" }] : [];
  }
  const childIds = [...new Set(items.flatMap(agentThreadIds))];
  return childIds.flatMap((id) => {
    const belongsToChild = (item: Item) =>
      item.type === "subAgentActivity"
        ? item.agentThreadId === id
        : item.receiverThreadIds?.includes(id);
    // Narrow shared tool calls to this child so other children's states do not leak in.
    const childItems = items.filter(belongsToChild).map((item) =>
      item.type === "collabAgentToolCall"
        ? {
            ...item,
            receiverThreadIds: [id],
            agentsStates: item.agentsStates?.[id]
              ? { [id]: item.agentsStates[id] }
              : undefined,
          }
        : item,
    );
    const task = workflowFromTurn({ ...turn, items: childItems }, conversation);
    if (!task) return [];
    return [
      {
        ...task,
        id: `${conversation.id}:${turn.id}:${id}`,
        kind: "agent" as const,
      },
    ];
  });
}
export function workflowsIn(conversations: Conversation[]) {
  return conversations.flatMap((conversation) =>
    conversation.turns.flatMap((turn) => tasksFromTurn(turn, conversation)),
  );
}
