/**
 * Offline preview of the two motion pieces measured from video in the
 * 2026-09-29 narrow-and-motion audit: the writing star and Cowork's "Running
 * workflow…" row. /preview/motion.html
 */
import { createRoot } from "react-dom/client";
import { SparkMark } from "../../src/ui/SparkMark";
import { RunningWorkflow } from "../../src/transcript/workflow/RunningWorkflow";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
import "../../src/transcript/code-transcript.css";

function Preview() {
  return (
    <div
      className="mode-chat"
      style={{ padding: 24, background: "#191919", minHeight: "100vh" }}
    >
      <div
        className="response-stream-mark"
        data-testid="star"
        style={{ margin: "0 0 24px 4px" }}
      >
        <SparkMark />
      </div>
      <div className="assistant-content" data-testid="workflow">
        <RunningWorkflow startedAt={Date.now() - 63000} />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
