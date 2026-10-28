/** Offline renderer fixture for generated Codex tool item families. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ItemView } from "../../src/ui/ItemView";
import type { Item } from "../../shared/types";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
import "../../src/transcript/activity-motion.css";
function Preview() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timers = [1500, 3200, 4800, 6800, 8500].map((ms, index) =>
      setTimeout(() => setPhase(index + 1), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  const dynamic: Item = {
    id: "dynamic",
    type: "dynamicToolCall",
    namespace: "fixture",
    tool: "lookup",
    arguments: { query: "synthetic" },
    status: phase >= 2 ? "completed" : "inProgress",
    lifecycleStatus: phase >= 2 ? "completed" : "inProgress",
    success: phase >= 2 ? true : null,
    contentItems:
      phase >= 2
        ? [{ type: "inputText", text: "Synthetic result ready." }]
        : [],
  };
  const collaboration: Item = {
    id: "collab",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: phase >= 4 ? "completed" : "inProgress",
    lifecycleStatus: phase >= 4 ? "completed" : "inProgress",
    prompt: "Inspect synthetic code only",
    receiverThreadIds: ["synthetic-agent"],
    agentsStates: {
      "synthetic-agent": {
        status: phase >= 4 ? "completed" : "running",
        message: phase >= 4 ? "Done" : "Working",
      },
    },
  };
  const event: Item = {
    id: "event",
    type: "subAgentActivity",
    kind: "started",
    agentPath: "/root/synthetic",
  };
  const image: Item = {
    id: "image",
    type: "imageGeneration",
    status: "completed",
    lifecycleStatus: "completed",
    revisedPrompt: "A synthetic placeholder",
    result: "",
    savedPath: "/synthetic/image.png",
  };
  return (
    <main
      style={{
        width: "min(620px,calc(100% - 40px))",
        margin: "125px auto",
        fontFamily: "system-ui",
      }}
    >
      <p style={{ fontSize: 12, color: "#929292" }}>
        Offline tool families · phase {phase}
      </p>
      <ItemView item={dynamic} mode="code" onArtifact={() => {}} />
      {phase >= 3 && (
        <>
          <ItemView item={collaboration} mode="code" onArtifact={() => {}} />
          <ItemView item={event} mode="code" onArtifact={() => {}} />
        </>
      )}
      {phase >= 5 && (
        <ItemView item={image} mode="code" onArtifact={() => {}} />
      )}
    </main>
  );
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Preview />);
