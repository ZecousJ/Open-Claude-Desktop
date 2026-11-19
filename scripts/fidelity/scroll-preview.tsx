import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useTranscriptScroll } from "../../src/transcript/useTranscriptScroll";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import type { Conversation } from "../../shared/types";
import "../../src/styles.css";
import "../../src/transcript/chat-transcript.css";
import "../../src/transcript/activity-motion.css";
import "../../src/transcript/thinking-motion.css";
const time = Date.now();
const seed: Conversation = {
  id: "scroll-test",
  title: "Synthetic scroll test",
  mode: "chat",
  providerId: "offline",
  model: "fixture",
  pinned: false,
  archived: false,
  createdAt: time,
  updatedAt: time,
  turns: Array.from({ length: 3 }, (_, i) => ({
    id: `old-${i}`,
    prompt: `Earlier synthetic prompt ${i + 1}`,
    attachments: [],
    createdAt: time,
    status: "completed",
    items: [
      {
        id: `answer-${i}`,
        type: "agentMessage",
        text: "An earlier synthetic answer for testing scroll position.\n\n".repeat(
          6,
        ),
      },
    ],
  })),
};
function Preview() {
  const [conversation, setConversation] = useState(seed);
  const [stream, setStream] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [reading, setReading] = useState(false);
  const scrollEvents = useTranscriptScroll(
    viewport,
    follow,
    conversation,
    "chat",
  );
  useEffect(() => {
    if (!stream) return;
    let count = 0;
    const id = setInterval(() => {
      count++;
      setConversation((c) => ({
        ...c,
        turns: c.turns.map((t, i) =>
          i === c.turns.length - 1
            ? {
                ...t,
                status: count >= 18 ? "completed" : "inProgress",
                items: [
                  {
                    id: "stream",
                    type: "agentMessage",
                    lifecycleStatus: count >= 18 ? "completed" : "inProgress",
                    text: "Streaming synthetic paragraph. This text adds visible height while leaving earlier reading undisturbed.\n\n".repeat(
                      count,
                    ),
                  },
                ],
              }
            : t,
        ),
      }));
      if (count >= 18) {
        clearInterval(id);
        setStream(false);
      }
    }, 500);
    return () => clearInterval(id);
  }, [stream]);
  function submit() {
    setStream(false);
    setConversation((c) => ({
      ...c,
      turns: [
        ...c.turns,
        {
          id: `new-${c.turns.length}`,
          prompt:
            "Latest synthetic prompt. Keep this bubble near the top while the short response arrives.",
          attachments: [],
          createdAt: Date.now(),
          status: "completed",
          items: [
            {
              id: "command",
              type: "commandExecution",
              command: 'printf "synthetic output\\n"',
              status: "completed",
              aggregatedOutput: "synthetic output\n",
            },
            {
              id: "short",
              type: "agentMessage",
              text: "A short synthetic reply.",
            },
          ],
        },
      ],
    }));
  }
  return (
    <div
      className="mode-chat"
      style={{ height: "100vh", display: "flex", flexDirection: "column" }}
    >
      <header
        style={{
          height: 46,
          flexShrink: 0,
          display: "flex",
          gap: 20,
          alignItems: "center",
          padding: "0 24px",
          background: "var(--bg)",
        }}
      >
        <button onClick={submit}>Submit short turn</button>
        <button onClick={() => setStream(true)}>Stream long response</button>
        <span>
          {reading ? "Reading earlier messages" : "Following latest response"}
        </span>
      </header>
      <div
        className="messages-scroll"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Chat messages"
        onWheel={scrollEvents.onWheel}
        onScroll={() => {
          scrollEvents.onScroll();
          setReading(!follow.current);
        }}
      >
        <div className="messages">
          {conversation.turns.map((turn) => (
            <div className="turn" key={turn.id}>
              <div className="user-message">{turn.prompt}</div>
              <div className="assistant-message">
                <div className="assistant-content">
                  <ChatTurnContent
                    turn={turn}
                    awaitingApproval={false}
                    onArtifact={() => {}}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <footer
        style={{
          height: 100,
          flexShrink: 0,
          width: 784,
          margin: "auto",
          padding: 16,
        }}
      >
        <div className="composer" style={{ minHeight: 48, padding: 12 }}>
          Offline scroll fixture — no model or user data
        </div>
      </footer>
    </div>
  );
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Preview />);
