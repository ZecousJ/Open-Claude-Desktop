import { useEffect, useLayoutEffect, useState, type MouseEvent } from "react";
import type { Attachment, Conversation } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { api } from "../desktop-api";
import { formatText } from "../i18n";
import { Modal } from "../ui/Controls";
import { WithTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";
import { draftPreview } from "../split-view/discard-draft";
import { StatusDot } from "../sidebar/StatusDot";
import { rowStatus } from "../sidebar/row-status";
import { awaitsInput } from "../code-tools/AskingRows";
import {
  isFolderPermissionError,
  requestFolderAccess,
} from "./useFolderAccess";
import {
  asksFirst,
  closeSpinOff,
  expandedRoom,
  expandedSlots,
  setSpinOffMinimized,
  setSpinOffSession,
  takeSpinOffSeed,
  useSpinOffWindows,
  type SpinOffWindow,
} from "./spin-off-store";
import { MiniTaskComposer } from "./MiniTaskComposer";
import { MiniSessionView } from "./MiniSessionView";
import "./spin-off-windows.css";

/**
 * The task windows: a row at the bottom right of the Cowork page, newest at the
 * right, as many expanded (416px) as fit beside the others collapsed (256px),
 * the most recently raised first. Each is a card with a header (its name;
 * "From: {title}" on a spun-off draft while expanded; once its task started,
 * the task's status; a Cowork badge, Maximize once its task started, Minimize /
 * Expand, Close) over the compact task composer (MiniTaskComposer) or, once the
 * task started, its live view (MiniSessionView). Start task spins the task off
 * the conversation after the reply the window was opened on, or starts a quick
 * task, without leaving the page; the window then follows the task until it is
 * maximized (opened) or closed. Closing a draft with something in it asks first
 * ("Discard draft?").
 */
export default function SpinOffWindows() {
  const app = useApp();
  const list = useSpinOffWindows();
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(SLOT_GUESS);
  useLayoutEffect(() => {
    if (!row) return;
    const measure = () => {
      const next = expandedRoom(row.clientWidth, list.length);
      setRoom((value) => (value === next ? value : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [row, list.length]);
  // A window whose task is open in full goes (the live row's effect).
  const activeId = app.active?.id;
  useEffect(() => {
    if (!activeId) return;
    for (const item of list)
      if (item.sessionId === activeId) closeSpinOff(item.id);
  }, [activeId, list]);
  const expanded = expandedSlots(list, room);
  // Shown on the Chat and Cowork page only; kept while elsewhere.
  const hidden = app.page !== "chat" || app.mode === "code";
  return (
    <div ref={setRow} className="spin-off-row" hidden={hidden || undefined}>
      {list.map((item) => (
        <SpinOffCard
          key={item.id}
          item={item}
          expanded={expanded.has(item.slot)}
        />
      ))}
    </div>
  );
}
/** Before the row is measured, every window may show expanded. */
const SLOT_GUESS = 3;

const find = (list: Conversation[], id: string | undefined) =>
  id ? list.find((conversation) => conversation.id === id) : undefined;

/** Holds what clips the card's content until its opening has finished. */
function useSettled(expanded: boolean) {
  const [settled, setSettled] = useState(expanded);
  useEffect(() => {
    if (!expanded) return setSettled(false);
    // The live window's width and body ease over 150ms.
    const timer = setTimeout(() => setSettled(true), 160);
    return () => clearTimeout(timer);
  }, [expanded]);
  return settled;
}

function SpinOffCard({
  item,
  expanded,
}: {
  item: SpinOffWindow;
  expanded: boolean;
}) {
  const app = useApp();
  const conversations = app.snapshot.conversations;
  const parent = find(conversations, item.parentId);
  const task = find(conversations, item.sessionId);
  const branch = item.source === "branch";
  const settled = useSettled(expanded);
  const [asking, setAsking] = useState(false);
  // The draft: its words (seeded once), files, place and model.
  const [text, setText] = useState(item.seed?.prompt ?? "");
  // A prompt from outside keeps its caution band while there are words.
  const [unsafeSeed] = useState(Boolean(item.seed?.unsafe));
  const unsafe = unsafeSeed && Boolean(text.trim());
  useEffect(() => {
    if (item.seed) takeSpinOffSeed(item.id);
  }, []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [cwd, setCwd] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const project = app.snapshot.projects.find((p) => p.id === projectId);
  // A spun-off task starts on the model of the task it comes from.
  const [target, setTarget] = useState(() =>
    parent
      ? { providerId: parent.providerId, model: parent.model }
      : { providerId: app.providerId, model: app.model },
  );
  const [starting, setStarting] = useState(false);
  const toggle = () => setSpinOffMinimized(item.id, expanded);
  const name = item.sessionId
    ? task?.title || "Task"
    : branch
      ? "Spin off a new task"
      : "Quick task";
  const label = item.sessionId
    ? name
    : branch
      ? "Spin-off task draft"
      : "Quick task draft";
  const hasDraft = Boolean(text.trim() || attachments.length);

  const start = async (askedForFolder = false): Promise<void> => {
    const prompt = text.trim();
    if ((!prompt && !attachments.length) || starting) return;
    if (!target.model) {
      app.notify(
        app.snapshot.modelUnavailable ??
          "Model service unavailable. Contact the server operator.",
      );
      return;
    }
    setStarting(true);
    let refused: string | undefined;
    try {
      let started: Conversation;
      if (branch && item.parentId && item.turnId) {
        const sameModel =
          parent?.providerId === target.providerId &&
          parent?.model === target.model;
        if (sameModel && !attachments.length)
          started = await api.forkConversation(item.parentId, {
            turnId: item.turnId,
            prompt,
          });
        else {
          // Files or another model: the fork's first message carries them.
          const forked = await api.forkConversation(item.parentId, {
            turnId: item.turnId,
          });
          app.upsert(forked);
          started = await api.send({
            conversationId: forked.id,
            text: prompt,
            mode: forked.mode,
            cwd: forked.cwd,
            projectId: forked.projectId,
            attachments,
            ...target,
          });
        }
      } else
        started = await api.send({
          text: prompt,
          mode: "cowork",
          cwd,
          projectId,
          attachments,
          ...target,
          ...(asksFirst(item.source) ? { asksFirst: true } : {}),
        });
      app.upsert(started);
      setText("");
      setAttachments([]);
      setSpinOffSession(item.id, started.id);
    } catch (error) {
      // Cowork's folder was never allowed (R11): ask, then start again.
      const folder = cwd ?? project?.cwd;
      if (
        !askedForFolder &&
        !branch &&
        folder &&
        isFolderPermissionError(error)
      )
        refused = folder;
      else app.report(error);
    } finally {
      setStarting(false);
    }
    if (!refused) return;
    try {
      const result = await requestFolderAccess(refused, {
        notify: app.notify,
        ...(project && !cwd ? { projectId: project.id } : {}),
      });
      if (result === "granted") await start(true);
    } catch (error) {
      app.report(error);
    }
  };
  const close = () => {
    if (!item.sessionId && hasDraft) setAsking(true);
    else closeSpinOff(item.id);
  };
  const maximize = () => {
    if (!task) return;
    closeSpinOff(item.id);
    app.openConversation(task);
  };
  const stop = (event: MouseEvent) => event.stopPropagation();
  const toggleLabel = expanded ? "Minimize" : "Expand";
  const closeLabel = item.sessionId
    ? "Close"
    : branch
      ? "Close spin-off task draft"
      : "Close quick task draft";
  const working = task?.turns.at(-1)?.status === "inProgress";
  const needsApproval = Boolean(
    task && app.snapshot.approvals.some((a) => a.conversationId === task.id),
  );
  return (
    <section
      className="spin-off-window"
      aria-label={label}
      data-collapsed={!expanded || undefined}
      data-settled={settled || undefined}
    >
      <header className="spin-off-header" onClick={toggle}>
        <div className="spin-off-title">
          <button
            type="button"
            className="spin-off-heading"
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            <span
              className="spin-off-name"
              data-no-translate={item.sessionId ? true : undefined}
            >
              {name}
            </span>
            {branch && !item.sessionId && expanded && (
              <span className="spin-off-from">
                {formatText("From: {title}", {
                  title: parent?.title || "Local task",
                })}
              </span>
            )}
          </button>
          {task && (
            <span className="spin-off-status" onClick={stop}>
              <StatusDot
                status={rowStatus(task, {
                  working,
                  needsApproval,
                  question: awaitsInput(app.snapshot.approvals, task.id),
                })}
                onToggle={() =>
                  void api
                    .updateConversation(task.id, { unread: !task.unread })
                    .then(app.upsert)
                    .catch(app.report)
                }
              />
            </span>
          )}
        </div>
        <div className="spin-off-controls" onClick={stop}>
          <span className="spin-off-badge">Cowork</span>
          {item.sessionId && task && (
            <WithTooltip label="Maximize">
              {(tooltip) => (
                <button
                  {...tooltip}
                  type="button"
                  className="spin-off-icon"
                  aria-label="Maximize"
                  onClick={maximize}
                >
                  <AppIcon name="ArrowOutSquare" />
                </button>
              )}
            </WithTooltip>
          )}
          <WithTooltip label={toggleLabel}>
            {(tooltip) => (
              <button
                {...tooltip}
                type="button"
                className="spin-off-icon"
                aria-label={toggleLabel}
                onClick={toggle}
              >
                <span
                  className={
                    expanded ? "spin-off-minus down" : "spin-off-minus up"
                  }
                >
                  <AppIcon name="Minus" />
                </span>
              </button>
            )}
          </WithTooltip>
          <WithTooltip label="Close">
            {(tooltip) => (
              <button
                {...tooltip}
                type="button"
                className="spin-off-icon"
                aria-label={closeLabel}
                onClick={close}
              >
                <AppIcon name="X" />
              </button>
            )}
          </WithTooltip>
        </div>
      </header>
      {item.sessionId ? (
        <div className="spin-off-session" hidden={!expanded || undefined}>
          <MiniSessionView sessionId={item.sessionId} shown={expanded} />
        </div>
      ) : (
        <div
          className="spin-off-body"
          data-open={expanded || undefined}
          inert={!expanded || undefined}
        >
          <div className="spin-off-body-inner">
            <div className="spin-off-draft">
              <MiniTaskComposer
                placeholder={
                  branch
                    ? "How should I spin off this task for you?"
                    : "What else can I work on?"
                }
                text={text}
                setText={setText}
                attachments={attachments}
                setAttachments={setAttachments}
                focus={expanded}
                unsafe={unsafe}
                starting={starting}
                onStart={() => void start()}
                place={
                  branch
                    ? undefined
                    : {
                        cwd,
                        setCwd,
                        project,
                        setProjectId: (id) => {
                          setProjectId(id);
                          // A project brings its own folder.
                          setCwd(undefined);
                        },
                      }
                }
                permission={!branch && !asksFirst(item.source)}
                providerId={target.providerId}
                model={target.model}
                onModel={(providerId, model) =>
                  setTarget({ providerId, model })
                }
              />
            </div>
          </div>
        </div>
      )}
      {asking && (
        <Modal
          title="Discard draft?"
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => setAsking(false)}
        >
          <p className="confirm-body">
            {formatText(
              "“{preview}” hasn’t been sent. Start a task from it, or discard it?",
              { preview: draftPreview(text || attachments[0]?.name || "") },
            )}
          </p>
          <div className="button-row">
            <button className="secondary" onClick={() => setAsking(false)}>
              Keep editing
            </button>
            <button
              className="secondary"
              onClick={() => {
                setAsking(false);
                void start();
              }}
            >
              Start task
            </button>
            <button
              className="primary danger-button"
              onClick={() => {
                setAsking(false);
                closeSpinOff(item.id);
              }}
            >
              Discard
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
