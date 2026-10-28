import { useRef, useState } from "react";
import {
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronRight,
  X,
} from "../../ui/glyphs";
import type { AgentTranscript } from "../../../shared/types";
import { AgentContextCard } from "./AgentContextCard";
import { AgentTranscriptBody } from "./AgentTranscriptBody";
import { Star } from "../../ui/Star";
import {
  BackgroundPanelResize,
  useBackgroundPanelWidth,
  useRailWidth,
} from "../../conversation/BackgroundPanelResize";
import { useAgentTranscript } from "./useAgentTranscript";
import { usePaneExpandToggle } from "../../app/pane-expand";

/**
 * A child Agent's own conversation in the Background tasks rail: opened from
 * the task list's View transcript, or straight from the Agent's row in the
 * conversation. Back leads to the task list.
 */
export function AgentTranscriptPanel({
  conversationId,
  agentId,
  title,
  accountId,
  onBack,
  onClose,
  onRead,
  onError,
}: {
  conversationId: string;
  agentId: string;
  title: string;
  /** Keeps the rail width the user dragged, shared with the task list. */
  accountId?: string;
  onBack: () => void;
  onClose: () => void;
  onRead: (conversationId: string, agentId: string) => Promise<AgentTranscript>;
  onError: (error: unknown) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  usePaneExpandToggle("agent", () => setExpanded((value) => !value));
  const { width, setWidth, persist } = useBackgroundPanelWidth(accountId);
  const { transcript, error, retry } = useAgentTranscript(
    conversationId,
    agentId,
    onRead,
    onError,
  );
  const panelRef = useRef<HTMLElement>(null);
  useRailWidth(panelRef, expanded ? undefined : width);
  return (
    <aside
      ref={panelRef}
      className={`work-panel background-tasks-panel agent-transcript-panel${expanded ? " expanded" : ""}`}
      aria-label={`Agent transcript: ${title}`}
    >
      {!expanded && (
        <BackgroundPanelResize
          panel={panelRef}
          width={width}
          onResize={(value) => {
            setExpanded(false);
            setWidth(value);
          }}
          persist={persist}
        />
      )}
      <header>
        <button aria-label="Back to background tasks" onClick={onBack}>
          <ChevronLeft size={17} />
        </button>
        {/* The subagent's description; "Running subagent" while it has none. */}
        <strong title={title}>{title.trim() || "Running subagent"}</strong>
        <div>
          <button
            aria-label={
              expanded ? "Restore agent transcript" : "Expand agent transcript"
            }
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button aria-label="Close agent transcript" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="agent-transcript-scroll">
        {/* Loading is a blank panel, as the code file panel's is. */}
        {!transcript && !error && (
          <p className="agent-transcript-loading" role="status">
            Loading transcript…
          </p>
        )}
        {error && (
          <div className="agent-transcript-error" role="alert">
            <strong>Could not load the Agent transcript</strong>
            <p>{error}</p>
            <button onClick={retry}>Retry</button>
          </div>
        )}
        {transcript && (
          <>
            <p className="agent-transcript-model">
              Model <b>{transcript.model}</b>
            </p>
            {transcript.context && (
              <AgentContextCard context={transcript.context} />
            )}
            <AgentTranscriptBody
              items={transcript.items}
              truncated={transcript.truncated}
            />
            {transcript.status === "running" && (
              <div
                className="agent-transcript-running"
                role="status"
                aria-label="Agent is working"
              >
                <Star size={19} />
              </div>
            )}
            {/* The original's status words: Done, Failed, Stopped. */}
            {transcript.status === "failed" && (
              <div
                className="agent-transcript-terminal is-failed"
                role="status"
              >
                Failed
              </div>
            )}
            {transcript.status === "stopped" && (
              <div className="agent-transcript-terminal" role="status">
                Stopped
              </div>
            )}
            {transcript.status === "completed" &&
              transcript.items.length > 0 && (
                <div className="agent-transcript-terminal" role="status">
                  Done
                </div>
              )}
            {!transcript.items.length && (
              <p className="muted">The agent has not produced a message yet.</p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
