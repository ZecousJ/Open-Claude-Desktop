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

// Status precedence and tiles (live claude.ai bundle, 2026-10-14, c1f04f7e1-BY11zgRA.js).
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

// The live tile overrides its Spinner map with scaled dots (live claude.ai
// bundle, 2026-10-14, c1f04f7e1-BY11zgRA.js and shared-18-C7CGav6q.js).
function TaskRunningDots() {
  return (
    <span className="cowork-tile-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

// The idle tile uses CircleDashedIcon, not Clock (live claude.ai bundle,
// 2026-10-14, c1f04f7e1-BY11zgRA.js).
function TaskIdleGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M96.26,37.05A8,8,0,0,1,102,27.29a104.11,104.11,0,0,1,52,0,8,8,0,0,1-2,15.75,8.15,8.15,0,0,1-2-.26,88.09,88.09,0,0,0-44,0A8,8,0,0,1,96.26,37.05ZM53.79,55.14a104.05,104.05,0,0,0-26,45,8,8,0,0,0,15.42,4.27,88,88,0,0,1,22-38.09A8,8,0,0,0,53.79,55.14ZM43.21,151.55a8,8,0,1,0-15.42,4.28,104.12,104.12,0,0,0,26,45,8,8,0,0,0,11.41-11.22A88.14,88.14,0,0,1,43.21,151.55ZM150,213.22a88,88,0,0,1-44,0,8,8,0,1,0-4,15.49,104.11,104.11,0,0,0,52,0,8,8,0,0,0-4-15.49ZM222.65,146a8,8,0,0,0-9.85,5.58,87.91,87.91,0,0,1-22,38.08,8,8,0,1,0,11.42,11.21,104,104,0,0,0,26-45A8,8,0,0,0,222.65,146Zm-9.86-41.54a8,8,0,0,0,15.42-4.28,104,104,0,0,0-26-45,8,8,0,0,0-11.41,11.22A88,88,0,0,1,212.79,104.45Z" />
    </svg>
  );
}
