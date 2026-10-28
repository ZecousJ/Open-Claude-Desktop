import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowUp, Eye, GitBranch, Trash2, X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Mode } from "../../shared/types";
import { IconButton, CopyButton } from "../ui/Controls";
import { Markdown } from "../ui/Markdown";
import { isComposingKey } from "../ui/ime";
import { ReplyCopyIcon } from "../ui/ReplyIcons";
import { ReplyToolbarButton } from "../transcript/ReplyToolbarButton";
import { RingedStopIcon } from "../ui/RingedStopIcon";
import { shortcutText, showsShortcuts, WithTooltip } from "../ui/Tooltip";
import {
  askSideChat,
  clearSideChat,
  clearSideChatContext,
  setSideChatDraft,
  stopSideChat,
  type SideChatState,
  type SideMessage,
} from "./side-chat-store";
import { formatText, t } from "../i18n";
import "./side-chat.css";

/** Elements the panel's outside click leaves alone: what opens over everything else. */
const overlays =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"]';

/**
 * The side chat: a card at the conversation's lower right with its own short
 * list of questions and answers. "Ask on the side without touching the main
 * chat. Claude sees the full context, and nothing here is added to it." Each
 * answer has Copy and Branch to new chat. Escape closes it; in Chat so does a
 * click outside it, as the original's floating panel does. An answer shows as
 * it is written. Code's has Stop in the field's place while it writes (Escape
 * does the same instead of closing); the Chat one has none.
 */
export function SideChatPanel({
  conversationId,
  state,
  mode,
  platform,
  closing = false,
  branchReason,
  inheritedMessageCount = 0,
  onClose,
  onBranch,
}: {
  conversationId: string;
  state: SideChatState;
  mode: Mode;
  platform: string;
  /** The card is on its way out (it has been closed). */
  closing?: boolean;
  /** Why Branch to new chat is unavailable (an incognito chat cannot be forked). */
  branchReason?: string;
  /** How many messages of the main chat it sees; the note under the header shows above 0 (Chat). */
  inheritedMessageCount?: number;
  onClose: () => void;
  /** Forks the conversation and carries the question and its answer into it. */
  onBranch: (question: string | undefined, answer: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const { messages, thinking, partial, stopping, error, draft, context } =
    state;
  const canStop = mode === "code";

  // Focus goes to the field on opening and back to where it was on closing.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    field.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected && document.activeElement === document.body)
        before.focus({ preventScroll: true });
    };
  }, []);
  // A passage was sent over from the page: the field is ready for its question.
  useEffect(() => {
    if (context) field.current?.focus({ preventScroll: true });
  }, [context]);
  // Code: while an answer is written the field is disabled and the card itself
  // holds the focus, so Escape reaches it and stops the answer. When it is
  // done the field takes it back.
  useEffect(() => {
    const element = panel.current;
    const active = document.activeElement;
    if (thinking) {
      if (
        canStop &&
        element &&
        (!active || active === document.body || element.contains(active))
      )
        element.focus({ preventScroll: true });
    } else if (active === document.body || active === element)
      field.current?.focus({ preventScroll: true });
  }, [thinking, canStop]);
  // Chat only: a click outside closes the card (not one on a dialog or menu).
  useEffect(() => {
    if (mode !== "chat") return;
    const outside = (event: Event) => {
      const target = event.target as Element | null;
      if (!target?.isConnected || panel.current?.contains(target)) return;
      const over = target.closest(overlays);
      if (over && !over.contains(panel.current)) return;
      onClose();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("touchstart", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("touchstart", outside);
    };
  }, [mode, onClose]);
  // The list follows new lines unless the person scrolled up.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages, thinking, partial]);
  // The field grows with its text, up to 120px.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [draft]);

  const send = () => {
    if (!draft.trim() || thinking) return;
    following.current = true;
    void askSideChat(conversationId, draft);
  };
  // The answer being written follows the questions and answers already there.
  const shown: SideMessage[] =
    partial === undefined
      ? messages
      : [...messages, { role: "assistant", text: partial }];
  const placeholder = messages.length ? "Follow up…" : "Ask a quick question…";
  return (
    <aside
      ref={panel}
      className="side-chat"
      tabIndex={-1}
      data-mode={mode}
      data-state={closing ? "closed" : "open"}
      inert={closing || undefined}
      aria-label="Side chat"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        // Code: Escape stops an answer being written, and only then closes.
        if (canStop && thinking) {
          event.preventDefault();
          if (!stopping) void stopSideChat(conversationId);
          return;
        }
        onClose();
      }}
    >
      <header className="side-chat-header">
        <span className="side-chat-title">Side chat</span>
        {showsShortcuts && (
          <kbd className="side-chat-keys">
            {shortcutText(platform, ["mod", ";"])}
          </kbd>
        )}
        {messages.length > 0 && (
          <IconButton
            label="Clear side chat"
            onClick={() => {
              clearSideChat(conversationId);
              requestAnimationFrame(() => field.current?.focus());
            }}
          >
            <Trash2 size={16} />
          </IconButton>
        )}
        <IconButton label="Close side chat" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {mode === "chat" && inheritedMessageCount > 0 && (
        <div className="side-chat-inherited">
          <Eye size={14} aria-hidden="true" />
          <span>
            {formatText(
              inheritedMessageCount === 1
                ? "Sees {count} message from main chat"
                : "Sees {count} messages from main chat",
              { count: inheritedMessageCount },
            )}
          </span>
          <span className="side-chat-inherited-mode">{t("read-only")}</span>
        </div>
      )}
      {messages.length === 0 && partial === undefined ? (
        <div className="side-chat-empty">
          <p>
            {mode === "code"
              ? "Chat about this session without touching the main thread. Claudex sees the full context, and nothing here is added to the session."
              : "Ask on the side without touching the main chat. Claudex sees the full context, and nothing here is added to it."}
          </p>
        </div>
      ) : (
        <div
          ref={list}
          className="side-chat-list"
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              48;
          }}
        >
          {shown.map((message, index) =>
            message.role === "user" ? (
              <div className="side-chat-question" key={index}>
                {message.context && (
                  <blockquote title={message.context}>
                    {message.context}
                  </blockquote>
                )}
                <p>{message.text}</p>
              </div>
            ) : (
              <div className="side-chat-answer" key={index}>
                <div className="side-chat-answer-text">
                  <Markdown
                    text={message.text}
                    streaming={index === messages.length}
                  />
                </div>
                {index < messages.length && (
                  <div className="side-chat-actions">
                    <CopyButton
                      iconOnly
                      text={message.text}
                      glyph={<ReplyCopyIcon />}
                      message="reply"
                    />
                    <span title={branchReason}>
                      <ReplyToolbarButton
                        label="Branch to new chat"
                        disabled={Boolean(branchReason)}
                        onClick={() => onBranch(message.question, message.text)}
                      >
                        <GitBranch size={16} strokeWidth={1.5} />
                      </ReplyToolbarButton>
                    </span>
                  </div>
                )}
              </div>
            ),
          )}
          {thinking && (
            <p className="side-chat-thinking" role="status">
              Thinking…
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="side-chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="side-chat-compose">
        {context && (
          <div className="side-chat-context">
            <blockquote title={context}>{context}</blockquote>
            <IconButton
              label="Remove selected text"
              onClick={() => {
                clearSideChatContext(conversationId);
                field.current?.focus();
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
        <div className="side-chat-field">
          <textarea
            ref={field}
            rows={1}
            value={draft}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={thinking}
            onChange={(event) =>
              setSideChatDraft(conversationId, event.target.value)
            }
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !isComposingKey(event)
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
          {canStop && thinking ? (
            <WithTooltip
              label={stopping ? "Stopping…" : "Stop response"}
              shortcut={["Esc"]}
            >
              {(tip) => (
                <button
                  {...tip}
                  type="button"
                  className="send-button stop"
                  aria-label="Stop response"
                  aria-busy={stopping || undefined}
                  onClick={() => void stopSideChat(conversationId)}
                >
                  {stopping ? (
                    <Spinner inheritColor size={14} className="spin" />
                  ) : (
                    <RingedStopIcon size={13} />
                  )}
                </button>
              )}
            </WithTooltip>
          ) : (
            <button
              type="button"
              className="send-button"
              aria-label="Send"
              disabled={thinking || !draft.trim()}
              onClick={send}
            >
              <ArrowUp size={20} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
