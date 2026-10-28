/** Offline Code transcript fixture. Synthetic data only; no bridge, backend, credentials or history. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { ItemView } from "../../src/ui/ItemView";
import { CodeTurnStatus } from "../../src/transcript/CodeTurnStatus";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
import "../../src/transcript/code-transcript.css";
import "../../src/transcript/activity-motion.css";
import "../../src/transcript/thinking-motion.css";
import type { Item, Turn } from "../../shared/types";

const COMMAND =
  'for i in 1 2 3 4 5; do [ "$i" -gt 1 ] && sleep 1; echo "tick $i"; done';
const PHASES = [
  "Waiting",
  "Thinking",
  "Still thinking",
  "Thought",
  "Running tools",
  "Completed",
] as const;
// Phase offsets (seconds since submission) follow claude-code-terminal-lifecycle-own-001: 2s thinking, 15s still thinking, 29s thought, 32s tools.
const AT = [0, 2, 15, 29, 32, 40];

function turnFor(phase: number, start: number): Turn {
  const reasoning: Item = {
    id: "r",
    type: "reasoning",
    summary: [],
    startedAt: start + 2000,
    lifecycleStatus: phase >= 3 ? "completed" : "inProgress",
    ...(phase >= 3 ? { completedAt: start + 29000 } : {}),
  };
  const command: Item = {
    id: "c",
    type: "commandExecution",
    command: COMMAND,
    shell: "bash",
    description:
      phase >= 5
        ? "Printed tick 1 to 5, one second apart"
        : "Printing tick 1 to 5, one second apart",
    lifecycleStatus: phase >= 5 ? "completed" : "inProgress",
    status: phase >= 5 ? "completed" : "inProgress",
    aggregatedOutput:
      phase >= 5 ? "tick 1\ntick 2\ntick 3\ntick 4\ntick 5\n" : "",
  };
  const items =
    phase === 0
      ? []
      : phase < 3
        ? [reasoning]
        : phase < 5
          ? [reasoning, command]
          : [
              reasoning,
              command,
              { id: "m", type: "agentMessage", text: "Done" },
            ];
  return {
    id: "synthetic",
    prompt: "",
    attachments: [],
    createdAt: start,
    status: phase >= 5 ? "completed" : "inProgress",
    items,
    outputTokens: phase >= 3 ? 36 : 0,
  };
}

function Preview() {
  const [held, setHeld] = useState(1);
  const [start, setStart] = useState(() => Date.now() - AT[1] * 1000);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(id);
  }, []);
  const hold = (phase: number) => {
    setHeld(phase);
    setStart(Date.now() - AT[phase] * 1000 - (phase === 3 ? 0 : 0));
  };
  const turn = turnFor(held, held === 3 ? Date.now() - 29000 : start);
  return (
    <div className="mode-code">
      <main style={{ width: 770, margin: "160px auto", color: "var(--text)" }}>
        <div style={{ font: "12px sans-serif", marginBottom: 40 }}>
          {PHASES.map((name, index) => (
            <button
              key={name}
              onClick={() => hold(index)}
              aria-pressed={held === index}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="assistant-content">
          {turn.items.map((item) => (
            <ItemView
              key={item.id}
              item={item}
              mode="code"
              turnStatus={turn.status}
              startedAt={turn.createdAt}
              onArtifact={() => {}}
            />
          ))}
          <CodeTurnStatus
            turn={turn}
            awaitingApproval={false}
            runningTasks={held === 4 ? 1 : 0}
          />
        </div>
      </main>
    </div>
  );
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Preview />);
