import { CircleDashed } from "lucide-react";
import type { Conversation, SessionPullRequestState } from "../../shared/types";
import { Check, Eye, Hand, X } from "../ui/glyphs";
import { isRunning } from "../conversation/unread";
import { TaskPullRequestGlyph } from "./task-pr-glyphs";
export type TaskStatus =
  "running" | "needs_input" | "errored" | "ready_review" | "done" | "idle";
export function taskStatus(
  conversation: Conversation,
  waiting = false,
): TaskStatus {
  if (waiting) return "needs_input";
  const last = conversation.turns.at(-1);
  if (last?.error || last?.status === "failed") return "errored";
  if (isRunning(conversation)) return "running";
  const completed = conversation.turns.some(
    (turn) => turn.status === "completed",
  );
  return completed ? (conversation.unread ? "ready_review" : "done") : "idle";
}

// Status precedence and tiles.
export function TaskStatusTile({
  status,
  pullRequestState,
}: {
  status: TaskStatus;
  pullRequestState?: SessionPullRequestState;
}) {
  if (pullRequestState && (status === "done" || status === "idle")) {
    return (
      <span
        aria-hidden="true"
        className={`cowork-status-tile cowork-pr-${pullRequestState}`}
      >
        <TaskPullRequestGlyph state={pullRequestState} />
      </span>
    );
  }
  const Icon = {
    running: TaskRunningDots,
    needs_input: Hand,
    errored: X,
    ready_review: Eye,
    done: Check,
    idle: TaskIdleGlyph,
  }[status];
  return (
    <span
      aria-hidden="true"
      className={`cowork-status-tile cowork-status-${status}`}
    >
      <Icon size={20} />
    </span>
  );
}

// A running task's tile: three scaled dots.
function TaskRunningDots() {
  return (
    <span className="cowork-tile-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

// The idle tile: a dashed circle.
function TaskIdleGlyph({ size }: { size: number }) {
  return <CircleDashed size={size} strokeWidth={1.75} aria-hidden="true" />;
}
