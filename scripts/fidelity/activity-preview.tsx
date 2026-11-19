/** Offline renderer fixture. No bridge, backend, credentials, or user history. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
import "../../src/transcript/activity-motion.css";
import "../../src/transcript/thinking-motion.css";
import type { Turn } from "../../shared/types";
function Preview() {
  const [start, setStart] = useState(Date.now);
  const [seconds, setSeconds] = useState(0);
  const [motionInfo, setMotionInfo] = useState("");
  const [motionEvents, setMotionEvents] = useState("");
  useEffect(() => {
    const log = (event: Event) => {
      const e = event as TransitionEvent;
      if ((e.target as Element)?.matches(".command-activity > summary > svg"))
        setMotionEvents((value) =>
          `${value} ${e.type}:${e.propertyName}:${e.elapsedTime}`.slice(-400),
        );
    };
    for (const name of [
      "transitionrun",
      "transitionstart",
      "transitionend",
      "transitioncancel",
    ])
      document.addEventListener(name, log, true);
    return () => {
      for (const name of [
        "transitionrun",
        "transitionstart",
        "transitionend",
        "transitioncancel",
      ])
        document.removeEventListener(name, log, true);
    };
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      const arrow = document.querySelector(".command-activity > summary > svg");
      setMotionInfo(
        `Reduced motion: ${matchMedia("(prefers-reduced-motion: reduce)").matches}; chevron transition: ${arrow ? getComputedStyle(arrow).transitionDuration : "unmounted"}`,
      );
    }, 500);
    return () => clearInterval(id);
  }, []);
  const [heldPhase, setHeldPhase] = useState<number | null>(() =>
    Number(new URLSearchParams(location.search).get("phase") ?? 1),
  );
  useEffect(() => {
    const id = setInterval(() => setSeconds((Date.now() - start) / 1000), 100);
    return () => clearInterval(id);
  }, [start]);
  const phase = heldPhase ?? Math.min(3, 1 + Math.floor(seconds / 8));
  const turn: Turn = {
    id: "synthetic",
    prompt: "",
    attachments: [],
    createdAt: start,
    status: phase === 3 ? "completed" : "inProgress",
    items:
      phase === 0
        ? []
        : [
            {
              id: "command",
              type: "commandExecution",
              command: 'printf "reference tick\\n"',
              shell: "bash",
              aggregatedOutput: phase > 1 ? "reference tick\n" : "",
              status: phase === 1 ? "inProgress" : "completed",
              lifecycleStatus: phase === 1 ? "inProgress" : "completed",
            },
          ],
  };
  return (
    <main
      className="mode-chat"
      style={{ width: 800, margin: "180px auto", color: "var(--text)" }}
    >
      <div style={{ font: "14px sans-serif", marginBottom: 40 }}>
        <div
          style={{
            position: "fixed",
            left: 24,
            bottom: 24,
            maxWidth: 1200,
            font: "11px monospace",
          }}
        >
          <small>{motionInfo}</small>
          <div>{motionEvents}</div>
        </div>
        <p>
          {"Offline animation fixture · "}
          {
            ["Starting", "Tool running", "Post-tool thinking", "Completed"][
              phase
            ]
          }
        </p>
        <button
          onClick={() => {
            setStart(Date.now());
            setSeconds(0);
            setHeldPhase(null);
          }}
        >
          Run lifecycle
        </button>{" "}
        <button onClick={() => setHeldPhase(1)}>Hold running tool</button>{" "}
        <button onClick={() => setHeldPhase(2)}>Hold thinking</button>{" "}
        <button onClick={() => setHeldPhase(3)}>Complete</button>
      </div>
      <ChatTurnContent
        turn={turn}
        awaitingApproval={false}
        onArtifact={() => {}}
      />
    </main>
  );
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Preview />);
