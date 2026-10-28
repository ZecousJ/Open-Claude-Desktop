/** Offline single-Agent visual fixture: eight independent children in one parent turn. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BackgroundTasksPanel } from "../../src/conversation/BackgroundTasksPanel";
import { SingleAgentEvent } from "../../src/transcript/agents/SingleAgentEvent";
import { tasksFromTurn } from "../../shared/workflow-model";
import type { Conversation, Turn } from "../../shared/types";
import "../../src/styles.css";
const now = Date.now();
const titles = [
  "Inventory synthetic classroom capabilities",
  "Research interaction alternatives",
  "Review accessibility and keyboard flow",
  "Inspect narrow-window layout",
  "Compare typography samples",
  "Measure hover and held states",
  "Record sidebar transitions",
  "Check agent transcript layout",
];
const items = titles.map((name, index) => ({
  id: `child-${index}`,
  type: "subAgentActivity",
  kind: "started",
  agentThreadId: `agent-${index}`,
  agentPath: `/root/${name.toLowerCase().replaceAll(" ", "-")}`,
  agentStartedAt: { [`agent-${index}`]: now - (181 - index * 19) * 1000 },
  agentTokenUsage: { [`agent-${index}`]: 275500 - index * 28000 },
  agentToolUses: { [`agent-${index}`]: 71 - index * 7 },
  agentCurrentAction: {
    [`agent-${index}`]: index % 2 ? "Fetching" : "Running a command",
  },
  agentsStates: { [`agent-${index}`]: { status: "running" } },
}));
const turn: Turn = {
  id: "parent-turn",
  prompt: "Synthetic interface review",
  attachments: [],
  createdAt: now - 185000,
  status: "completed",
  items,
};
const conversation: Conversation = {
  id: "parent-conversation",
  title: "Synthetic parent review",
  mode: "code",
  providerId: "fixture",
  model: "Opus 5.5",
  pinned: false,
  archived: false,
  createdAt: turn.createdAt,
  updatedAt: now,
  turns: [turn],
};
let readCount = 0;
function Preview() {
  const [open, setOpen] = useState(true);
  const selected = tasksFromTurn(turn, conversation).at(-1)!;
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#1b1b1a",
        color: "#c8c7c4",
      }}
    >
      <main style={{ flex: 1, minWidth: 0, padding: "60px 15px" }}>
        <SingleAgentEvent task={selected} onOpen={() => setOpen(true)} />
      </main>
      {open && (
        <BackgroundTasksPanel
          conversations={[conversation]}
          accountId="fixture-account"
          activeConversationId={conversation.id}
          engineReady={false}
          onClose={() => setOpen(false)}
          onReadAgent={async (_id, agentId) => {
            if (
              new URLSearchParams(location.search).get("fail") === "once" &&
              ++readCount === 1
            )
              throw Error("Synthetic child read failure");
            return {
              model: "Opus 5.5",
              context:
                new URLSearchParams(location.search).get("context") ===
                "adaptive"
                  ? "Synthetic sentence with a few longer words to demonstrate responsive wrapping. ".repeat(
                      6,
                    )
                  : "Synthetic context for " +
                    agentId +
                    "\n\n- Inspect the interface\n- Report findings clearly",
              status:
                new URLSearchParams(location.search).get("status") === "failed"
                  ? "failed"
                  : new URLSearchParams(location.search).get("status") ===
                      "stopped"
                    ? "stopped"
                    : "running",
              items: [
                {
                  id: "reply",
                  type: "agentMessage",
                  text: "I will inspect the interface structure, then compare interactive states.",
                },
                {
                  id: "command",
                  type: "commandExecution",
                  command: "echo fixture",
                  aggregatedOutput: "fixture",
                  status: "completed",
                },
                {
                  id: "failed",
                  type: "commandExecution",
                  command: "exit 1",
                  aggregatedOutput: "synthetic failure",
                  status: "failed",
                  exitCode: 1,
                },
              ],
              toolUses: 2,
            };
          }}
          onError={console.error}
        />
      )}
    </div>
  );
}
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light"
    ? "light"
    : "dark";
document.body.style.minWidth = "0";
createRoot(document.getElementById("root")!).render(<Preview />);
