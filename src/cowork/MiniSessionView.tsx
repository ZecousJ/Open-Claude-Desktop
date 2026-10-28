import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { openArtifact } from "../app/ArtifactHost";
import { api } from "../desktop-api";
import { ChatTurnContent } from "../transcript/ChatTurnContent";
import { CodeUserMessage } from "../transcript/CodeUserMessage";
import { ComposerDock } from "../approval/ComposerDock";
import { SparkMark } from "../ui/SparkMark";
import { Star } from "../ui/Star";
import { isComposingKey } from "../ui/ime";
import { useTurnStopping, trackStopping } from "../transcript/turn-stopping";
import { MiniComposerControls } from "./MiniComposerControls";

/** How close to the end the list must be to keep following new text. */
const pinSlack = 24;

/**
 * A task window's live view of its task once it started: at most 28rem tall,
 * the task's messages in a list that keeps to its end while it writes, the
 * approvals it waits on, a status row while it works ("Working on it…" by the
 * shimmering star, or "Couldn’t set up this task"), and a reply field ("Reply
 * to Claudex…") that stops the task while it works. An archived task takes no
 * messages ("Open it to unarchive it"). Before the task arrives it says
 * "Connecting…".
 */
export function MiniSessionView({
  sessionId,
  shown,
}: {
  sessionId: string;
  /** The window is expanded: the reply field may take the focus. */
  shown: boolean;
}) {
  const app = useApp();
  const task = app.snapshot.conversations.find((c) => c.id === sessionId);
  useFullTurns(task);
  if (!task) return <div className="mini-session-connecting">Connecting…</div>;
  return <MiniSession task={task} shown={shown} />;
}

/** A shortened task (the web snapshot's `slim`) loads its full turns. */
function useFullTurns(task: Conversation | undefined) {
  const app = useApp();
  const slimId = task?.slim ? task.id : undefined;
  useEffect(() => {
    if (!slimId) return;
    let live = true;
    void api
      .conversationTurns(slimId)
      .then((full) => {
        if (!live) return;
        app.setSnapshot((s) =>
          s
            ? {
                ...s,
                conversations: s.conversations.map((c) =>
                  c.id === slimId && c.slim
                    ? { ...c, ...full, slim: false }
                    : c,
                ),
              }
            : s,
        );
      })
      .catch(() => {
        /* The cut texts stay; the next full event brings the rest. */
      });
    return () => {
      live = false;
    };
  }, [slimId]);
}

function MiniSession({ task, shown }: { task: Conversation; shown: boolean }) {
  const app = useApp();
  const approvals = app.snapshot.approvals;
  const awaiting = approvals.some((a) => a.conversationId === task.id);
  const last = task.turns.at(-1);
  const running = last?.status === "inProgress";
  const stopping = useTurnStopping(running ? (last?.id ?? "") : "") && running;
  // Nothing came back from the task's only turn: it never got going.
  const setupFailed =
    task.turns.length === 1 &&
    last?.status === "failed" &&
    !last.items.some((item) => item.type === "agentMessage");
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = list.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  return (
    <div className="mini-session mode-cowork">
      <div
        ref={list}
        className="mini-session-list"
        role="region"
        aria-label="Chat messages"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <=
            pinSlack;
        }}
      >
        <div className="messages">
          {task.turns.map((turn) => (
            <div className="turn" key={turn.id}>
              {!turn.compaction && <CodeUserMessage turn={turn} />}
              <div className="assistant-message">
                <div className="assistant-content">
                  <ChatTurnContent
                    conversation={task}
                    turn={turn}
                    awaitingApproval={awaiting}
                    onArtifact={(value) =>
                      openArtifact(app, { conversationId: task.id, ...value })
                    }
                    variant="cowork"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <ComposerDock
          conversation={task}
          approvals={approvals}
          settings={app.snapshot.settings}
          platform={app.snapshot.platform}
          updatePreference={app.updatePreference}
          onSent={app.upsert}
          onFocusComposer={() => {}}
          onError={app.report}
        />
      </div>
      {(running || setupFailed) && (
        <div className="mini-session-status" aria-live="polite">
          {running ? (
            <SparkMark size={20} follow={false} />
          ) : (
            <Star size={20} />
          )}
          {setupFailed ? (
            <span className="mini-session-status-text failed">
              Couldn’t set up this task
            </span>
          ) : (
            <span className="mini-session-status-text">Working on it…</span>
          )}
        </div>
      )}
      {task.archived ? (
        <p className="mini-session-ended">
          This task is archived and can’t take new messages. Open it to
          unarchive it.
        </p>
      ) : (
        <ReplyField
          task={task}
          shown={shown}
          running={running}
          stopping={stopping}
        />
      )}
    </div>
  );
}

/** The live view's compact reply field. */
function ReplyField({
  task,
  shown,
  running,
  stopping,
}: {
  task: Conversation;
  shown: boolean;
  running: boolean;
  stopping: boolean;
}) {
  const app = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  const send = async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    setText("");
    try {
      if (running) {
        const steered = await api.steerTurn(task.id, prompt, []);
        if (steered) {
          app.upsert(steered.conversation);
          return;
        }
      }
      app.upsert(
        await api.send({
          conversationId: task.id,
          text: prompt,
          mode: task.mode,
          attachments: [],
          providerId: task.providerId,
          model: task.model,
        }),
      );
    } catch (error) {
      setText(prompt);
      app.report(error);
    } finally {
      setSending(false);
      if (shown) field.current?.focus();
    }
  };
  const placeholder = "Reply to Claudex…";
  return (
    <div className="mini-composer mini-session-reply">
      <div className="mini-composer-words">
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isComposingKey(event)
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <MiniComposerControls
          running={running}
          hasContent={Boolean(text.trim())}
          disabled={sending}
          stopping={stopping}
          onSend={() => void send()}
          onStop={() =>
            void trackStopping(task, api.interrupt(task.id)).catch(app.report)
          }
        />
      </div>
    </div>
  );
}
