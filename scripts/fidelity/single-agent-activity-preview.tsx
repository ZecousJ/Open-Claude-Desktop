/** Offline tool-and-child activity from the supplied static reference, with synthetic text. */
import { createRoot } from "react-dom/client";
import { SingleAgentEvent } from "../../src/transcript/agents/SingleAgentEvent";
import type { WorkflowSummary } from "../../shared/workflow-model";
import "../../src/styles.css";
const task: WorkflowSummary = {
  id: "fixture",
  kind: "agent",
  conversationId: "fixture",
  title: "Research robotics sim classroom tools",
  description: "",
  startedAt: Date.now() - 51_000,
  status: "running",
  agents: [
    { id: "child", name: "research", phase: "Agents", status: "running" },
  ],
  phases: [],
};
function Preview() {
  return (
    <main style={{ padding: "0 15px 0 17px", width: 746 }}>
      <SingleAgentEvent
        task={task}
        priorTool={{
          id: "tool",
          type: "mcpToolCall",
          server: "Claude Docs",
          tool: "Edit doc",
          status: "completed",
          arguments: { document: "Synthetic test doc" },
          result: {
            content: [{ type: "text", text: "Edited synthetic content" }],
          },
        }}
        onOpen={() => {}}
      />
    </main>
  );
}
document.documentElement.dataset.theme = "dark";
document.documentElement.classList.add("single-agent-activity-fixture");
document.body.style.minWidth = "0";
document.body.style.background = "#151515";
createRoot(document.getElementById("root")!).render(<Preview />);
