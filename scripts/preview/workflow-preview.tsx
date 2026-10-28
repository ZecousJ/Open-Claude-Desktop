/** Offline Workflow fixture. One synthetic child; no account, model service or Claude history. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowCard } from "../../src/transcript/workflow/WorkflowCard";
import { BackgroundTasksPanel } from "../../src/conversation/BackgroundTasksPanel";
import { workflowFromTurn } from "../../shared/workflow-model";
import type { Conversation, Turn } from "../../shared/types";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
function Preview() {
  const [open, setOpen] = useState(false),
    [finished, setFinished] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [tick, setTick] = useState(0);
  const turn: Turn = {
    id: "turn",
    prompt: "Synthetic workflow test",
    attachments: [],
    createdAt: Date.now() - 382000,
    status: finished ? "completed" : "inProgress",
    items: [
      {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["fixture-agent"],
        prompt:
          "Review synthetic interface states across two fixture windows; inspect hover, click and background task progress",
        workflowPhases: ["Review", "Verify"],
        agentTokenUsage: { "fixture-agent": 12345 },
        model: "Fixture model",
        agentsStates: {
          "fixture-agent": {
            status: finished || advanced ? "completed" : "running",
            message: finished ? "Done" : "Reviewing",
          },
        },
      },
      {
        id: "activity",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "fixture-agent",
        agentPath: "/root/review:fixture",
      },
      ...(advanced
        ? [
            {
              id: "verify",
              type: "subAgentActivity",
              kind: "started",
              agentThreadId: "fixture-verify",
              agentPath: "/root/verify:fixture",
              agentTokenUsage: { "fixture-verify": 2345 + tick },
              agentsStates: {
                "fixture-verify": {
                  status: finished ? "completed" : "running",
                },
              },
            },
          ]
        : []),
    ],
  };
  const conversation: Conversation = {
    id: "synthetic",
    title: "synthetic-workflow",
    mode: "code",
    providerId: "fixture",
    model: "fixture-model",
    pinned: false,
    archived: false,
    createdAt: turn.createdAt,
    updatedAt: Date.now(),
    turns: [turn],
  };
  const workflow = workflowFromTurn(turn, conversation)!;
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        background: "#151515",
        color: "#c7c6c2",
      }}
    >
      <main
        style={{
          flex: 1,
          minWidth: 0,
          padding: "65px 15px",
          font: "14px/21px system-ui",
        }}
      >
        <p style={{ maxWidth: 600, margin: "0 0 18px" }}>
          Synthetic agent workflow completed its setup and started a background
          review.
        </p>
        <WorkflowCard workflow={workflow} onOpen={() => setOpen(true)} />
        <button
          id="advance-workflow"
          onClick={() => setAdvanced(true)}
          style={{ marginTop: 22, color: "#888" }}
        >
          Start Verify phase
        </button>
        <button
          id="update-workflow"
          onClick={() => setTick((value) => value + 1)}
          style={{ marginTop: 22, color: "#888" }}
        >
          Update running usage
        </button>
        <button
          id="complete-workflow"
          onClick={() => setFinished(true)}
          style={{ marginTop: 22, color: "#888" }}
        >
          Finish synthetic agent
        </button>
      </main>
      {open && (
        <BackgroundTasksPanel
          conversations={[conversation]}
          engineReady={false}
          onClose={() => setOpen(false)}
          onStop={async () => setFinished(true)}
          onError={console.error}
        />
      )}
    </div>
  );
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Preview />);
