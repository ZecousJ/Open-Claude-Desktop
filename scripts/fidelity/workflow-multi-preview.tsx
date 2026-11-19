/** Offline many-agent visual fixture, with synthetic prompts and counters only. */
import { createRoot } from "react-dom/client";
import { BackgroundTasksPanel } from "../../src/conversation/BackgroundTasksPanel";
import type { Conversation, Item, Turn } from "../../shared/types";
import "../../src/styles.css";
const startedAt = Date.now() - 20 * 60_000;
const phases: [string, string[]][] = [
  ["Understand", ["ui:map", "ui:logic"]],
  ["Evidence", ["data:public", "data:local"]],
  [
    "Find",
    [
      "find:layout",
      "find:motion",
      "find:tools",
      "find:states",
      "find:resize",
      "find:theme",
    ],
  ],
];
const children = phases.flatMap(([phase, names]) =>
  names.map((name, index) => ({
    id: `${phase}-${index}`,
    name,
    path: `/root/${name}`,
    phase,
    status: phase === "Find" ? "running" : "completed",
    tokens: 200_000 + index * 14_000,
  })),
);
const states = Object.fromEntries(
  children.map((child) => [child.id, { status: child.status, message: null }]),
);
const tokenUsage = Object.fromEntries(
  children.map((child) => [child.id, child.tokens]),
);
const durations = Object.fromEntries(
  children
    .filter((child) => child.status === "completed")
    .map((child, index) => [child.id, (13 * 60 + index * 41) * 1000]),
);
const activity: Item[] = [
  {
    id: "spawn",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    receiverThreadIds: children.map((child) => child.id),
    workflowPhases: [
      "Understand",
      "Evidence",
      "Find",
      "Verify",
      "Critic",
      "Synthesize",
    ],
    model: "Fixture 5.5",
    prompt:
      "Review the synthetic interface across screenshots and interaction records; find, verify and prioritize the remaining mismatches",
    agentsStates: states,
    agentTokenUsage: tokenUsage,
    agentDurationMs: durations,
  },
  ...children.map((child) => ({
    id: `activity-${child.id}`,
    type: "subAgentActivity",
    kind: "started",
    agentThreadId: child.id,
    agentPath: child.path,
    workflowPhase: child.phase,
  })),
];
const turn: Turn = {
  id: "turn",
  prompt: "Synthetic Workflow comparison",
  attachments: [],
  createdAt: startedAt,
  status: "completed",
  items: activity,
};
const workflow: Conversation = {
  id: "workflow",
  title: "fixture-agent-review",
  mode: "code",
  providerId: "fixture",
  model: "Fixture 5.5",
  pinned: false,
  archived: false,
  createdAt: startedAt,
  updatedAt: Date.now(),
  threadId: "fixture-thread",
  turns: [turn],
};
const finished: Conversation = {
  ...workflow,
  id: "finished",
  title: "Previously completed synthetic run",
  threadId: undefined,
  turns: [
    {
      id: "done",
      prompt: "Synthetic",
      attachments: [],
      createdAt: startedAt - 100000,
      status: "completed",
      items: [
        {
          id: "child",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "finished-child",
          agentPath: "/root/fixture:done",
          agentsStates: { "finished-child": { status: "completed" } },
          agentDurationMs: { "finished-child": 1000 },
        },
      ],
    },
  ],
};
function Preview() {
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#151515",
        color: "#c7c6c2",
      }}
    >
      <BackgroundTasksPanel
        conversations={[workflow, finished]}
        activeConversationId="workflow"
        engineReady={false}
        onClose={() => {}}
        onReadAgent={async (_parent, agentId) => ({
          model: "Fixture 5.5",
          context: `Synthetic instructions for ${agentId}`,
          status: "completed",
          items: [
            {
              id: "answer",
              type: "agentMessage",
              text: "Synthetic child review complete.",
            },
          ],
          toolUses: 0,
        })}
        onError={console.error}
      />
    </div>
  );
}
document.documentElement.dataset.theme = "dark";
document.body.style.minWidth = "0";
createRoot(document.getElementById("root")!).render(<Preview />);
