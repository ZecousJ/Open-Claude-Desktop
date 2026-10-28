import type { Conversation, Item, Mode, Turn } from "../../../shared/types";
import type { Artifact } from "../../ui/components";
import { ItemView } from "../../ui/components";
import { CodeAgentRow, SingleAgentEvent } from "./SingleAgentEvent";
import { WorkflowCard } from "../workflow/WorkflowCard";
import { WorkflowRunRow } from "../workflow/WorkflowRunRow";
import { CodeToolGroup } from "../../code-tools/CodeToolGroup";
import { PlanRow } from "../../plan/PlanRow";
import {
  codeSegments,
  type CodeSegment,
} from "../../code-tools/code-tool-model";
import { useTranscriptSlots } from "../transcript-slots";
import { useTranscriptViewContext } from "../../transcript-view/transcript-view-store";
import { Fragment, Suspense } from "react";
import { lazyPiece, preloadPiece } from "../../ui/lazy-piece";
const ThinkingToolRecap = lazyPiece(() => import("../tools/ThinkingToolRecap"));
export const preloadThinkingToolRecap = () => preloadPiece(ThinkingToolRecap);
import {
  isWorkflowItem,
  tasksFromTurn,
  type WorkflowSummary,
} from "../../../shared/workflow-model";

/** The child Agent a single-Agent task row opens beside the conversation. */
export interface AgentTarget {
  conversationId: string;
  agentId: string;
  title: string;
}

/**
 * Opens a single Agent's own transcript, or the task list when the row has no
 * child thread yet or no transcript panel is wired.
 */
export function agentOpener(
  task: WorkflowSummary,
  onOpenWorkflow: () => void,
  onOpenAgent?: (target: AgentTarget) => void,
) {
  const agentId = task.agents[0]?.id;
  return () =>
    agentId && onOpenAgent
      ? onOpenAgent({
          conversationId: task.conversationId,
          agentId,
          title: task.title,
        })
      : onOpenWorkflow();
}

/** The Workflow tool's own call: its run item (WorkflowCard) stands for it. */
export const isWorkflowToolCall = (item: Item) =>
  item.type === "dynamicToolCall" && item.tool === "Workflow";

export function taskForItem(item: Item, turn: Turn, tasks: WorkflowSummary[]) {
  if (typeof item.workflowRunId === "string")
    return tasks.find((task) => task.runId === item.workflowRunId);
  const workflow = tasks.find(
    (task) => task.kind === "workflow" && !task.runId,
  );
  if (workflow)
    return item.id ===
      turn.items.find(
        (value) =>
          isWorkflowItem(value) && typeof value.workflowRunId !== "string",
      )?.id
      ? workflow
      : undefined;
  const id =
    item.type === "subAgentActivity"
      ? item.agentThreadId
      : item.type === "collabAgentToolCall"
        ? item.receiverThreadIds?.[0]
        : undefined;
  if (typeof id !== "string") return;
  if (
    item.type === "collabAgentToolCall" &&
    turn.items.some(
      (value) =>
        value.type === "subAgentActivity" && value.agentThreadId === id,
    )
  )
    return;
  return tasks.find((task) => task.agents[0]?.id === id);
}
export function AgentItems({
  conversation,
  turn,
  mode,
  onArtifact,
  onOpenWorkflow,
  onOpenAgent,
  background = new Set(),
  onOpenPlan,
}: {
  conversation: Conversation;
  turn: Turn;
  mode: Mode;
  onArtifact: (artifact: Artifact) => void;
  onOpenWorkflow: () => void;
  /** Opens a single Agent's transcript; without it the row opens the task list. */
  onOpenAgent?: (target: AgentTarget) => void;
  /** Code: command item ids still running as background terminals. */
  background?: Set<string>;
  /** Code: opens the Plan panel from a task-list update. */
  onOpenPlan?: () => void;
}) {
  const tasks = tasksFromTurn(turn, conversation);
  const consumedTools = new Map<string, Item>();
  // Code's agent line has no connector row; the call stays in the tool group.
  for (const task of tasks.filter(
    (task) => task.kind === "agent" && mode !== "code",
  )) {
    const index = turn.items.findIndex(
      (item) =>
        item.type === "subAgentActivity" &&
        item.agentThreadId === task.agents[0]?.id,
    );
    const prior = index > 0 ? turn.items[index - 1] : undefined;
    if (prior && ["mcpToolCall", "dynamicToolCall"].includes(prior.type))
      consumedTools.set(prior.id, prior);
  }
  const shown = turn.items.filter(
    (item) => !consumedTools.has(item.id) && !isWorkflowToolCall(item),
  );
  // Code folds consecutive tool calls into one row; the Thinking and Verbose
  // transcript views list each call on its own.
  const view = useTranscriptViewContext();
  // The phones draw Code's tool calls as the official collapsed row.
  const ToolGroup = useTranscriptSlots().CodeToolGroup ?? CodeToolGroup;
  const segments: CodeSegment[] =
    mode === "code"
      ? codeSegments(shown, { fold: view === "normal" })
      : shown.map((item) => ({ type: "item", item }));
  return (
    <>
      {segments.map((segment, segmentIndex) => {
        const previous = segments[segmentIndex - 1];
        if (segment.type === "tools")
          return (
            <Fragment key={segment.id}>
              {view !== "normal" && (
                <Suspense fallback={null}>
                  <ThinkingToolRecap
                    items={segment.items}
                    previous={
                      previous?.type === "item" ? previous.item : undefined
                    }
                  />
                </Suspense>
              )}
              <ToolGroup
                items={segment.items}
                turnStatus={turn.status}
                startedAt={turn.createdAt}
                background={background}
                onOpenBackground={onOpenWorkflow}
                onArtifact={onArtifact}
              />
            </Fragment>
          );
        const item = segment.item;
        if (mode === "code" && item.type === "taskPlan" && onOpenPlan)
          return <PlanRow key={item.id} item={item} onOpen={onOpenPlan} />;
        if (!isWorkflowItem(item))
          return (
            <ItemView
              key={item.id}
              item={item}
              mode={mode}
              turnStatus={turn.status}
              startedAt={turn.createdAt}
              onArtifact={onArtifact}
            />
          );
        const task = taskForItem(item, turn, tasks);
        if (!task) return null;
        const index = turn.items.indexOf(item),
          prior = consumedTools.get(turn.items[index - 1]?.id);
        if (task.kind === "agent" && mode === "code")
          return (
            <CodeAgentRow
              key={`${item.id}:${task.id}`}
              task={task}
              onOpen={agentOpener(task, onOpenWorkflow, onOpenAgent)}
            />
          );
        if (task.runId && task.status !== "running")
          return <WorkflowRunRow key={item.id} workflow={task} />;
        // A running Workflow tool run: its row, then the compact card.
        if (task.runId && task.kind === "workflow" && mode === "code")
          return (
            <div key={item.id} className="code-workflow-running">
              <WorkflowRunRow workflow={task} />
              <WorkflowCard workflow={task} onOpen={onOpenWorkflow} />
            </div>
          );
        return task.kind === "agent" ? (
          <SingleAgentEvent
            key={`${item.id}:${task.id}`}
            task={task}
            priorTool={prior}
            onOpen={agentOpener(task, onOpenWorkflow, onOpenAgent)}
          />
        ) : (
          <WorkflowCard key={item.id} workflow={task} onOpen={onOpenWorkflow} />
        );
      })}
    </>
  );
}
