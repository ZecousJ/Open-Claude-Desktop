import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Conversation } from "../../shared/types";
import { prependSkillDraft } from "./skill-tokens";
import { useApp } from "../app/AppContext";
import { formatText } from "../i18n";
import { ReplyEditIcon } from "../ui/ReplyIcons";
import { TooltipGroup, WithTooltip } from "../ui/Tooltip";
import { prefersReducedMotion } from "../ui/usePresence";
import { MessageAttachments } from "./Attachments";
import { maxAttachmentsFor } from "./attachment-limits";
import { queuedGlyphs, type QueuedGlyphName } from "./queued-glyphs";
import { takeEditableQueued, type QueuedMessage } from "./queue";
import { sendQueuedNow } from "./queue";
import "./chat-queued-messages.css";

/**
 * Chat and Cowork's messages written while a reply runs, in the composer's
 * dock: the reference design ChatComposerQueuedMessages. Each message is the
 * user's bubble aligned to the right, its text muted; resting the pointer on a
 * row (or focusing into it) shows Send now (↵), Edit in composer and Remove
 * from queue. They sit to the right of the bubble, past the composer's edge,
 * when the column has room for them there, else to its left. The list scrolls
 * past min(40vh, 22rem); screen readers hear how many wait.
 *
 * A message the running turn already took (Claudex hands a message to it,
 * `turn/steer`) has no actions; it reads "✓ Sent" there until the model reads
 * it, as the Code bar does.
 */

/** A message that leaves fades down 6px over --motion-snap. */
const EXIT_MS = 120;
/**
 * One action's share of the gutter beside the bubble, and the gutter's edge.
 */
const ACTION_STEP = 32;
const GUTTER_EDGE = 8;
const gutterFor = (actions: number) =>
  actions > 0 ? actions * ACTION_STEP + GUTTER_EDGE : 0;

export type Placement = "end" | "start" | "none";

/** The screen reader's count. */
export function queuedStatus(count: number) {
  if (count === 0) return "";
  return count === 1
    ? "1 message queued. Will send after the current response."
    : formatText(
        "{count} messages queued. Will send after the current response.",
        { count: String(count) },
      );
}

const scrollable = (value: string) => value !== "" && value !== "visible";
/** The nearest ancestor that clips or scrolls. */
function clippingAncestor(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (scrollable(style.overflowX) || scrollable(style.overflowY)) return node;
  }
  return null;
}

/**
 * "end" when the column has `room` px to the right of the list (to its
 * clipping ancestor, else the window), "start" otherwise.
 */
function useRoomAtEnd(element: HTMLElement | null, room: number) {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const clip = clippingAncestor(element);
      const right = clip
        ? clip.getBoundingClientRect().left + clip.clientLeft + clip.clientWidth
        : document.documentElement.clientWidth;
      setFits(right - box.right >= room);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(document.documentElement);
    const clip = clippingAncestor(element);
    if (clip) observer.observe(clip);
    return () => observer.disconnect();
  }, [element, room]);
  return fits;
}

/** A queued-bar glyph, 16px. */
function Glyph({ name }: { name: QueuedGlyphName }) {
  const Icon = queuedGlyphs[name];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}

/** Keeps the composer focused when an action is pressed. */
const keepFocus = (event: { preventDefault: () => void }) =>
  event.preventDefault();

function Action({
  label,
  icon,
  busy = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <WithTooltip label={label} disabled={busy || disabled}>
      {(tooltip) => (
        <button
          {...tooltip}
          type="button"
          className="chat-queued-action"
          aria-label={label}
          aria-busy={busy || undefined}
          aria-disabled={busy || disabled || undefined}
          disabled={disabled}
          onMouseDown={keepFocus}
          onClick={() => {
            if (!busy && !disabled) onClick();
          }}
        >
          {icon}
          {busy && (
            <span className="chat-queued-spinner">
              <span />
              <span className="sr-only">Sending…</span>
            </span>
          )}
        </button>
      )}
    </WithTooltip>
  );
}

export interface ChatQueuedRowsProps {
  /** The rows as drawn, with the ones that just left fading out. */
  rows: { entry: QueuedMessage; exiting: boolean }[];
  onRemove?: (id: string) => void;
  onEdit?: (id: string) => void;
  onSendNow?: (id: string) => void;
  /** Where the actions go; measured from the column when left out. */
  placement?: Placement;
}

/** The list itself, drawn from its props. */
export function ChatQueuedRows({
  rows,
  onRemove,
  onEdit,
  onSendNow,
  placement: fixedPlacement,
}: ChatQueuedRowsProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const actions = Number(!!onRemove) + Number(!!onEdit) + Number(!!onSendNow);
  const gutter = gutterFor(actions);
  const roomAtEnd = useRoomAtEnd(
    fixedPlacement ? null : root,
    gutter + GUTTER_EDGE,
  );
  const placement: Placement =
    fixedPlacement ?? (actions === 0 ? "none" : roomAtEnd ? "end" : "start");
  const waiting = rows.filter(
    ({ entry, exiting }) => !exiting && entry.state === "queued",
  ).length;
  if (!rows.length) return null;
  return (
    <div
      ref={setRoot}
      className="chat-queued"
      data-placement={placement}
      tabIndex={-1}
      style={placement === "end" ? { marginInlineEnd: -gutter } : undefined}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {queuedStatus(waiting)}
      </div>
      <TooltipGroup>
        <ul
          role="list"
          aria-label="Queued messages"
          className="chat-queued-list"
          style={
            placement === "end"
              ? { marginInlineEnd: -8, paddingInlineEnd: gutter + 8 }
              : undefined
          }
        >
          {rows.map(({ entry, exiting }, index) => (
            <QueuedRow
              key={entry.id}
              entry={entry}
              exiting={exiting}
              first={index === 0}
              placement={placement}
              actions={actions}
              onRemove={onRemove}
              onEdit={onEdit}
              onSendNow={onSendNow}
            />
          ))}
        </ul>
      </TooltipGroup>
    </div>
  );
}

function QueuedRow({
  entry,
  exiting,
  placement,
  actions,
  onRemove,
  onEdit,
  onSendNow,
}: {
  entry: QueuedMessage;
  exiting: boolean;
  first: boolean;
  placement: Placement;
  actions: number;
  onRemove?: (id: string) => void;
  onEdit?: (id: string) => void;
  onSendNow?: (id: string) => void;
}) {
  const hasTiles = entry.attachments.length > 0;
  const body = entry.text.trim() ? entry.text : null;
  if (body === null && !hasTiles) return null;
  const sent = entry.state === "steered";
  const busy = Boolean(entry.steering);
  // Beside the bubble at the start, the actions sit inside the bubble's box (to
  // its left); the row keeps room for them there.
  const inside = placement === "start" && body !== null;
  const band =
    placement === "none" ? null : (
      <div
        className="chat-queued-actions"
        data-side={placement === "end" ? "end" : inside ? "inside" : "start"}
        data-sent={sent || undefined}
      >
        {sent ? (
          <span className="chat-queued-sent">
            <span>
              <Glyph name="Check" />
            </span>
            Sent
          </span>
        ) : (
          <>
            {onSendNow && (
              <Action
                label="Send now"
                icon={<Glyph name="ArrowReturn" />}
                busy={busy}
                onClick={() => onSendNow(entry.id)}
              />
            )}
            {onEdit && (
              <Action
                label="Edit in composer"
                icon={<ReplyEditIcon />}
                disabled={busy}
                onClick={() => onEdit(entry.id)}
              />
            )}
            {onRemove && (
              <Action
                label="Remove from queue"
                icon={<Glyph name="X" />}
                disabled={busy}
                onClick={() => onRemove(entry.id)}
              />
            )}
          </>
        )}
      </div>
    );
  const reserve: CSSProperties | undefined =
    placement === "start"
      ? ({
          "--queued-reserve": `${actions * 24 + 6 + 8}px`,
          "--queued-yield": body === null ? 0 : 0.15,
        } as CSSProperties)
      : undefined;
  return (
    <li
      className="chat-queued-row"
      data-exiting={exiting || undefined}
      data-sent={sent || undefined}
      inert={exiting || undefined}
    >
      <div
        className="chat-queued-message"
        data-reserve={placement === "start" || undefined}
        style={reserve}
      >
        <div className="chat-queued-bubble" data-no-translate>
          {hasTiles && <MessageAttachments attachments={entry.attachments} />}
          {body !== null && <div className="chat-queued-text">{body}</div>}
          {inside && band}
        </div>
      </div>
      {!inside && band}
    </li>
  );
}

/**
 * The queue as drawn: the current entries, plus the ones that just left at
 * their old places while they fade out (none under reduced motion, and none
 * carried over to another conversation).
 */
export function useLeavingEntries(
  conversationId: string | undefined,
  entries: QueuedMessage[],
) {
  const [previous, setPrevious] = useState({ conversationId, entries });
  const [leaving, setLeaving] = useState<
    { entry: QueuedMessage; index: number }[]
  >([]);
  // Worked out while rendering, so the leaving message never blinks out.
  if (
    previous.entries !== entries ||
    previous.conversationId !== conversationId
  ) {
    setPrevious({ conversationId, entries });
    const ids = new Set(entries.map((entry) => entry.id));
    const gone =
      previous.conversationId === conversationId && !prefersReducedMotion()
        ? previous.entries.flatMap((entry, index) =>
            ids.has(entry.id) ? [] : [{ entry, index }],
          )
        : [];
    const kept =
      previous.conversationId === conversationId
        ? leaving.filter(({ entry }) => !ids.has(entry.id))
        : [];
    if (gone.length || kept.length !== leaving.length)
      setLeaving([...kept, ...gone]);
  }
  useEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const drawn = entries.map((entry) => ({ entry, exiting: false }));
  for (const { entry, index } of leaving)
    drawn.splice(Math.min(index, drawn.length), 0, { entry, exiting: true });
  return drawn;
}

/** The latest state of a conversation, as the window last heard it. */
function latestConversation(
  latest: { conversations: Conversation[] } | undefined | null,
  conversation: Conversation,
) {
  return (
    latest?.conversations.find((item) => item.id === conversation.id) ??
    conversation
  );
}

/**
 * The list for the open Chat or Cowork conversation, wired to its queue:
 * Send now hands a message to the running turn (or sends it at once when
 * the conversation is idle), Edit in composer puts it back into the draft,
 * Remove from queue takes it out. `onEmpty` hears when nothing is left to
 * draw (the last message has faded out).
 */
export default function ChatQueuedMessagesHost({
  conversation,
  entries,
  onEmpty,
}: {
  conversation: Conversation;
  entries: QueuedMessage[];
  onEmpty: () => void;
}) {
  const app = useApp();
  const conversationId = conversation.id;
  const rows = useLeavingEntries(conversationId, entries);
  const empty = rows.length === 0;
  useEffect(() => {
    if (empty) onEmpty();
  }, [empty]);
  const sendNow = (id: string) => {
    const current = latestConversation(app.latest.current, conversation);
    const held =
      "Couldn’t send the message now. It stays queued until Claudex finishes.";
    sendQueuedNow(current, id, app.upsert)
      .then((result) => {
        if (result === "held") app.report(held);
      })
      .catch(() => app.report(held));
  };
  const edit = (id: string) => {
    const entry = takeEditableQueued(conversationId, id);
    if (!entry) return;
    const draft = prependSkillDraft(entry, {
      text: app.text,
      skillTokens: app.skillTokens,
    });
    app.setText(draft.text);
    app.setSkillTokens?.(draft.skillTokens);
    app.setAttachments((value) =>
      [...entry.attachments, ...value].slice(0, maxAttachmentsFor(entry.mode)),
    );
    app.composer.current?.focus();
  };
  const remove = (id: string) => {
    takeEditableQueued(conversationId, id);
  };
  return (
    <ChatQueuedRows
      rows={rows}
      onRemove={remove}
      onEdit={edit}
      onSendNow={sendNow}
    />
  );
}
