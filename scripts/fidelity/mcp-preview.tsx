/** Offline MCP lifecycle fixture. No bridge, provider, files or user conversations. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { McpToolView } from "../../src/transcript/tools/McpToolView";
import type { Item } from "../../shared/types";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
import "../../src/transcript/activity-motion.css";
function Preview() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timers = [900, 2100, 3600, 5200].map((ms, index) =>
      setTimeout(() => setPhase(index + 1), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  const base: Item = {
    id: "synthetic-mcp",
    type: "mcpToolCall",
    server: "fixture",
    tool: "lookup",
    arguments: { query: "synthetic sample" },
    status: "inProgress",
    lifecycleStatus: "inProgress",
  };
  const item: Item =
    phase < 3
      ? {
          ...base,
          progress:
            phase === 0
              ? "Starting…"
              : phase === 1
                ? "Reading page 1 of 2"
                : "Reading page 2 of 2",
        }
      : {
          ...base,
          status: "completed",
          lifecycleStatus: "completed",
          progress: undefined,
          result: {
            content: [{ type: "text", text: "Found a synthetic item." }],
            structuredContent: { count: 1 },
          },
        };
  const failed: Item = {
    id: "synthetic-failed",
    type: "mcpToolCall",
    server: "fixture",
    tool: "lookup",
    arguments: { query: "missing synthetic item" },
    status: "failed",
    lifecycleStatus: "failed",
    error: { message: "The synthetic item was not found." },
  };
  return (
    <main
      style={{
        width: "min(620px,calc(100% - 40px))",
        margin: "140px auto",
        fontFamily: "system-ui",
      }}
    >
      <div style={{ color: "#929292", marginBottom: 28, fontSize: 12 }}>
        {"Offline MCP lifecycle · "}
        {phase < 3
          ? "running"
          : phase < 4
            ? "completed"
            : "completed and failed"}
      </div>
      <McpToolView item={item} />
      {phase >= 4 && <McpToolView item={failed} />}
    </main>
  );
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Preview />);
