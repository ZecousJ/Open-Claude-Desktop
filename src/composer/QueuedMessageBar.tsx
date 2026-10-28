import {
  useId,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { Conversation } from "../../shared/types";
import { prependSkillDraft } from "./skill-tokens";
import { useApp } from "../app/AppContext";
import { useT } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { TooltipGroup, WithTooltip } from "../ui/Tooltip";
import { maxAttachmentsFor } from "./attachment-limits";
import { queuedGlyphs, type QueuedGlyphName } from "./queued-glyphs";
import {
  clearQueued,
  moveQueued,
  queuedMessages,
  queuedPreview,
  takeEditableQueued,
  type QueuedMessage,
} from "./queue";
import { sendQueuedNow } from "./queue";
import {
  messageTextSize,
  transcriptTextSize,
  type MessageTextSize,
} from "../transcript/transcript-text-size";
import "./queued-message-bar.css";
import { QueuedList } from "./QueuedList";

/**
 * The Code session's queued messages: the original's QueuedMessageBar, which
 * the owner chose over the transcript bubbles of R-0832.
 *
 * One message is a band: "1 message queued", the message on one line, then Send
 * now (↵), Edit in composer and Remove from queue. Two or more fold into a
 * button, "N messages queued · Next: …", that opens a card listing them: each
 * row shows the message on up to two lines with a drag handle (to change the
 * order they are sent in) and a ⋮ menu (Edit in composer, Send now, Remove from
 * queue), the same menu on a right-click, and the card ends in Clear all. A
 * message the running turn already took reads "✓ Sent" until the model reads
 * it; it can no longer be edited, removed or moved (Codex cannot take a steered
 * message back).
 */
export interface QueuedMessageBarProps {
  entries: QueuedMessage[];
  /** The last message just left: the band sinks out, then `onExited`. */
  exiting?: boolean;
  onExited?: () => void;
  onCancel?: (id: string) => void;
  onEdit?: (id: string) => void;
  onSteer?: (id: string) => void;
  /** Drag and drop: `id` now takes `overId`'s place. */
  onReorder?: (id: string, overId: string) => void;
  onClearAll?: () => void;
  /** Starts with the list open (tests). */
  initiallyExpanded?: boolean;
  /**
   * The Transcript text size's message size: the bar's text follows the
   * transcript's.
   */
  textSize?: MessageTextSize;
}

/** A queued-bar glyph, 16px. */
export function Glyph({ name }: { name: QueuedGlyphName }) {
  const Icon = queuedGlyphs[name];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}

/** Keeps the composer focused when one of the bar's buttons is pressed. */
export const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

/**
 * A ghost icon button with its label as tooltip: 24px ("base"), or 20px
 * ("sm") in a row. A busy one spins in place, says what it is doing and does
 * nothing when pressed.
 */
export function GhostButton({
  label,
  icon,
  size = "base",
  busy = false,
  disabled = false,
  busyLabel,
  describedBy,
  expanded,
  menu = false,
  className = "",
  buttonRef,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  size?: "base" | "sm";
  busy?: boolean;
  disabled?: boolean;
  busyLabel?: string;
  describedBy?: string;
  expanded?: boolean;
  menu?: boolean;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <WithTooltip label={label} disabled={busy || disabled || Boolean(expanded)}>
      {(tooltip) => (
        <button
          {...tooltip}
          ref={buttonRef}
          type="button"
          className={`queued-bar-button ${className}`}
          data-size={size === "sm" ? "sm" : undefined}
          aria-label={label}
          aria-describedby={
            [tooltip["aria-describedby"], describedBy]
              .filter(Boolean)
              .join(" ") || undefined
          }
          aria-busy={busy || undefined}
          aria-disabled={busy || disabled || undefined}
          disabled={disabled}
          aria-haspopup={menu ? "menu" : undefined}
          aria-expanded={menu ? Boolean(expanded) : undefined}
          onMouseDown={keepFocus}
          onClick={(event) => {
            if (!busy && !disabled) onClick?.(event);
          }}
        >
          {icon}
          {busy && (
            <span className="queued-bar-spinner">
              <span />
              <span className="sr-only">{busyLabel}</span>
            </span>
          )}
        </button>
      )}
    </WithTooltip>
  );
}

/** "✓ Sent": the running turn took the message. */
export function SentHint() {
  return (
    <span className="queued-bar-sent" data-testid="queued-row-sent">
      <span>
        <Glyph name="Check" />
      </span>
      Sent
    </span>
  );
}

/**
 * Send now (↵) in the band: the running turn reads the message at its next
 * step, which the button says to screen readers.
 */
function SteerButton({
  busy,
  onPress,
}: {
  busy: boolean;
  onPress: () => void;
}) {
  const id = useId();
  return (
    <>
      <GhostButton
        label="Send now"
        icon={<Glyph name="ArrowReturn" />}
        busy={busy}
        busyLabel="Sending…"
        describedBy={id}
        onClick={onPress}
      />
      <span id={id} hidden>
        Claudex reads this message at its next step.
      </span>
    </>
  );
}

export const countLabel = (count: number) =>
  count === 1 ? `${count} message queued` : `${count} messages queued`;

/** One queued message: the band. */
function SingleBand({
  entry,
  onCancel,
  onEdit,
  onSteer,
}: {
  entry: QueuedMessage;
  onCancel?: (id: string) => void;
  onEdit?: (id: string) => void;
  onSteer?: (id: string) => void;
}) {
  const t = useT();
  const sent = entry.state === "steered";
  const locked = sent;
  const busy = Boolean(entry.steering);
  return (
    <div
      className="queued-bar-band"
      aria-busy={(busy && !sent) || undefined}
      data-entry={entry.id}
    >
      <span className="queued-bar-count">{countLabel(1)}</span>
      <span className="queued-bar-preview" data-no-translate>
        {queuedPreview(entry, t("[Image]"))}
      </span>
      {sent && <SentHint />}
      {!locked && onSteer && (
        <SteerButton busy={busy} onPress={() => onSteer(entry.id)} />
      )}
      {!locked && onEdit && (
        <GhostButton
          label="Edit in composer"
          icon={<AppIcon name="Edit" />}
          disabled={busy}
          onClick={() => onEdit(entry.id)}
        />
      )}
      {!locked && onCancel && (
        <GhostButton
          label="Remove from queue"
          icon={<Glyph name="X" />}
          disabled={busy}
          onClick={() => onCancel(entry.id)}
        />
      )}
    </div>
  );
}

/** Where each sortable row stood when a drag began. */
export type Slot = { id: string; top: number; height: number };

/** A drag in progress: by the pointer (past 5px) or picked up from the keyboard. */
export type Drag = {
  id: string;
  slots: Slot[];
  from: number;
  over: number;
  /** The pointer's travel (pointer drags), clamped to the list. */
  offset: number;
  keyboard: boolean;
};

/**
 * How far a row moves while another is dragged across it: by the dragged
 * row's height and the line between them, up or down (a vertical sortable
 * list).
 */
export function shiftFor(drag: Drag, index: number) {
  const { slots, from, over } = drag;
  const gapAfter = (i: number) =>
    slots[i + 1].top - slots[i].top - slots[i].height;
  if (from < over && index > from && index <= over)
    return -(slots[from].height + gapAfter(index - 1));
  if (from > over && index < from && index >= over)
    return slots[from].height + gapAfter(index);
  return 0;
}

/** Where the dragged row's centre lands among the others. */
export function overFor(slots: Slot[], from: number, offset: number) {
  const centre = slots[from].top + slots[from].height / 2 + offset;
  let over = from;
  for (let i = from + 1; i < slots.length; i++)
    if (centre > slots[i].top + slots[i].height / 2) over = i;
  for (let i = from - 1; i >= 0; i--)
    if (centre < slots[i].top + slots[i].height / 2) over = i;
  return over;
}

/** The bar itself, drawn from its props. */
export function QueuedMessageBar(props: QueuedMessageBarProps) {
  const { entries, exiting = false, onExited, textSize } = props;
  if (!entries.length) return null;
  const [first] = entries;
  return (
    <div
      className="queued-bar"
      data-text-size={textSize}
      data-exiting={exiting || undefined}
      inert={exiting || undefined}
      onAnimationEnd={
        exiting
          ? (event) => {
              if (event.target === event.currentTarget) onExited?.();
            }
          : undefined
      }
    >
      <TooltipGroup>
        {entries.length === 1 ? (
          <SingleBand
            entry={first}
            onCancel={props.onCancel}
            onEdit={props.onEdit}
            onSteer={props.onSteer}
          />
        ) : (
          <QueuedList {...props} />
        )}
      </TooltipGroup>
    </div>
  );
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
 * The bar for the open Code conversation, wired to its queue: Send now
 * hands a message to the running turn (or sends it at once when the
 * conversation is idle), Edit in composer puts it back into the draft,
 * Remove and Clear all take messages out, and a drag changes the order
 * they are sent in. Screen readers hear "Sent" when the turn takes a
 * message and "Read" when the model has read it.
 */
export default function QueuedMessageBarHost({
  conversation,
  entries,
  exiting,
  onExited,
}: {
  conversation: Conversation;
  entries: QueuedMessage[];
  exiting: boolean;
  onExited: () => void;
}) {
  const app = useApp();
  const conversationId = conversation.id;
  const announcement = useQueueAnnouncement(conversationId, entries);

  const steer = (id: string) => {
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
  const reorder = (id: string, overId: string) => {
    const waiting = queuedMessages(conversationId).filter(
      (entry) => entry.state === "queued",
    );
    const from = waiting.findIndex((entry) => entry.id === id);
    const to = waiting.findIndex((entry) => entry.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    // Moving down puts it after the row it was dropped on.
    moveQueued(conversationId, id, from < to ? waiting[to + 1]?.id : overId);
  };
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <QueuedMessageBar
        entries={entries}
        exiting={exiting}
        onExited={onExited}
        onCancel={remove}
        onEdit={edit}
        onSteer={steer}
        onReorder={reorder}
        onClearAll={() => clearQueued(conversationId)}
        textSize={messageTextSize(transcriptTextSize(app.snapshot.settings))}
      />
    </>
  );
}

/**
 * "Sent" when the running turn takes a queued message, "Read" when the
 * model has read one it took (it then leaves the queue), as the original
 * announces them.
 */
function useQueueAnnouncement(
  conversationId: string,
  entries: QueuedMessage[],
) {
  const [previous, setPrevious] = useState({ conversationId, entries });
  const [text, setText] = useState("");
  if (
    previous.entries !== entries ||
    previous.conversationId !== conversationId
  ) {
    setPrevious({ conversationId, entries });
    if (previous.conversationId === conversationId) {
      const now = new Map(entries.map((entry) => [entry.id, entry]));
      let next = "";
      for (const entry of previous.entries) {
        const after = now.get(entry.id);
        if (entry.state !== "steered" && after?.state === "steered")
          next = "Sent";
        else if (entry.state === "steered" && !after) next = "Read";
      }
      if (next) setText(next);
    }
  }
  return text;
}
