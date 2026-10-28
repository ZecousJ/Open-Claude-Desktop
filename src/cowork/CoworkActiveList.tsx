import { Fragment, useState } from "react";
import { ListTodo, Pin, Clock, Hand, X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Approval, Conversation } from "../../shared/types";
import { formatText, useLocale } from "../i18n";
import { isRunning } from "../conversation/unread";
import { relativeTime } from "../ui/RelativeTime";
import { taskStatus, type TaskStatus } from "./task-status";

export const activeListLimit = 5;

// Home rows use a status glyph, not the panel's tiles.
function HomeTaskStatus({
  status,
  conversation,
}: {
  status: TaskStatus;
  conversation: Conversation;
}) {
  const Icon =
    status === "needs_input"
      ? Hand
      : status === "errored"
        ? X
        : status === "running"
          ? Spinner
          : conversation.scheduledTaskId
            ? Clock
            : ListTodo;
  return (
    <span
      className={`cowork-home-status cowork-home-${status}`}
      aria-hidden="true"
    >
      <Icon
        size={20}
        className={status === "running" ? "cowork-task-spin" : undefined}
      />
      {conversation.unread &&
        status !== "running" &&
        status !== "needs_input" &&
        status !== "errored" && <span className="cowork-active-dot" />}
    </span>
  );
}

export function activeCoworkTasks(
  conversations: Conversation[],
  approvals: readonly Pick<Approval, "conversationId">[] = [],
) {
  const waiting = new Set(approvals.map((approval) => approval.conversationId));
  return conversations
    .filter((c) => c.mode === "cowork" && !c.archived && !c.incognito)
    .filter((c) => c.pinned || isRunning(c) || c.unread || waiting.has(c.id))
    .sort((a, b) => {
      const priority = (conversation: Conversation) =>
        waiting.has(conversation.id)
          ? 0
          : conversation.unread && !isRunning(conversation)
            ? 1
            : 2;
      return priority(a) - priority(b) || b.updatedAt - a.updatedAt;
    });
}

export function CoworkActiveList({
  conversations,
  approvals = [],
  onOpen,
  onClear,
}: {
  conversations: Conversation[];
  approvals?: readonly Pick<Approval, "conversationId">[];
  onOpen: (conversation: Conversation) => void;
  onClear: (finished: Conversation[]) => void;
}) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const tasks = activeCoworkTasks(conversations, approvals);
  if (!tasks.length) return null;
  const waiting = new Set(approvals.map((approval) => approval.conversationId));
  const finished = tasks.filter(
    (c) => c.unread && !isRunning(c) && !waiting.has(c.id),
  );
  const rows = expanded ? tasks : tasks.slice(0, activeListLimit);
  const pinned = tasks.some((c) => c.pinned);
  const active = tasks.some(
    (c) => c.unread || isRunning(c) || waiting.has(c.id),
  );
  const heading = pinned ? (active ? "Pinned or active" : "Pinned") : "Active";
  // Five rows, inset rules, and heading variants.
  return (
    <section className="cowork-active" aria-label={formatText(heading)}>
      <div className="cowork-active-head">
        <h3>{formatText(heading)}</h3>
        {finished.length > 0 && (
          <button type="button" onClick={() => onClear(finished)}>
            {formatText("Clear active")}
          </button>
        )}
      </div>
      <div className="cowork-active-rows">
        {rows.map((conversation, index) => (
          <Fragment key={conversation.id}>
            <a
              href={`/chat/${encodeURIComponent(conversation.id)}`}
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onOpen(conversation);
              }}
            >
              {conversation.pinned &&
              !conversation.unread &&
              ["idle", "done"].includes(
                taskStatus(conversation, waiting.has(conversation.id)),
              ) ? (
                <span className="cowork-home-status">
                  <Pin size={20} aria-hidden="true" />
                </span>
              ) : (
                <HomeTaskStatus
                  conversation={conversation}
                  status={taskStatus(
                    conversation,
                    waiting.has(conversation.id),
                  )}
                />
              )}
              <span className="cowork-active-text">
                <strong>
                  {conversation.title || formatText("Local task")}
                </strong>
                <small>
                  {relativeTime(conversation.updatedAt, Date.now())}
                </small>
              </span>
            </a>
            {index < rows.length - 1 && <hr />}
          </Fragment>
        ))}
      </div>
      {tasks.length > activeListLimit && (
        <button
          className="cowork-tasks-more"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {formatText(expanded ? "Show less" : "Show more")}
        </button>
      )}
    </section>
  );
}
