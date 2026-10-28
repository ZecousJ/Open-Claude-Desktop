import { useEffect, useRef, useState } from "react";
import { Pin, Split } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { AppIcon } from "../ui/app-icon";
import { Menu, type MenuPosition } from "../ui/Menu";
import { canSpeak } from "../voice/speech";
import { useReadAloud, type ReadAloudPhase } from "./read-aloud";
import { codeMenuReasons } from "../conversation/ConversationTitle";
import { notAvailable } from "../settings/unavailable";
import {
  ReplyCopyIcon,
  ReplyPauseIcon,
  ReplyReadAloudIcon,
  ReplyThumbDownIcon,
  ReplyThumbUpIcon,
} from "../ui/ReplyIcons";
import type { Conversation, Turn } from "../../shared/types";
import { CopyButton } from "../ui/Controls";
import { RelativeTime } from "../ui/RelativeTime";
import { ReplyVersions } from "./ReplyVersions";
import { ReplyToolbarButton } from "./ReplyToolbarButton";
import { useTranscriptSlots } from "./transcript-slots";
import { formatText } from "../i18n";
import { messageSummary } from "./message-summary";

/** The Read aloud button's name for each phase. */
export function readAloudLabel(phase: ReadAloudPhase) {
  return phase === "playing" || phase === "loading"
    ? "Pause"
    : phase === "paused"
      ? "Resume"
      : "Read aloud";
}

/**
 * Read aloud: the reply is spoken in the voice, speed and language chosen in
 * Settings → General → Voice, one reply at a time (read-aloud.ts). The button
 * reads Read aloud, then Pause while it speaks, then Resume; it is Read aloud
 * again once the reply was read. While the voices load it is Pause with a
 * spinner and "Loading…" as its tooltip, as the live one is while its audio
 * loads.
 */
function ReadAloud({ readKey, text }: { readKey: string; text: string }) {
  const { phase, toggle, stop } = useReadAloud(readKey);
  // Leaving the conversation stops its reading.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);
  if (!canSpeak() || !text.trim()) return null;
  return (
    <ReplyToolbarButton
      label={readAloudLabel(phase)}
      tooltip={phase === "loading" ? "Loading…" : undefined}
      className="reply-read-aloud"
      onClick={() => toggle(text)}
    >
      {phase === "loading" ? (
        <Spinner
          inheritColor
          className="spin reply-glyph"
          size={16}
          aria-hidden="true"
        />
      ) : phase === "playing" ? (
        <ReplyPauseIcon />
      ) : (
        <ReplyReadAloudIcon />
      )}
    </ReplyToolbarButton>
  );
}

/**
 * The first control of a message's actions, for screen readers: an older
 * message's actions stay hidden, out of the tab order, until the pointer
 * rests on it (chat-transcript.css), so this shows them and moves focus to
 * the first one (the original's "Show message actions"; source: desktop
 * bundle 2.31226.1 static JS). Once focus is inside, the row stays shown.
 */
export function ShowMessageActions({ heading }: { heading?: string } = {}) {
  // O14 uses the row heading in this focus entry so screen-reader action lists
  // distinguish replies.
  const label = heading
    ? formatText("Show message actions for {heading}", { heading })
    : "Show message actions";
  return (
    <button
      type="button"
      className="sr-only show-message-actions"
      onClick={(event) => {
        const row = event.currentTarget.parentElement;
        if (!row) return;
        row.setAttribute("data-revealed", "");
        row
          .querySelector<HTMLElement>(
            "button:not(.show-message-actions):not(:disabled)",
          )
          ?.focus();
        row.removeAttribute("data-revealed");
      }}
    >
      <span data-no-translate={Boolean(heading) || undefined}>{label}</span>
    </button>
  );
}

export function ReplyToolbar({
  conversation,
  turn,
  busy,
  versions = true,
  contextualActions = false,
  rating,
  onRating,
  onRetry,
  onSelect,
  onError,
  onSpinOff,
}: {
  conversation: Conversation;
  turn: Turn;
  busy: boolean;
  /**
   * Cowork: the More options menu's Spin off a new task; no menu without it.
   */
  onSpinOff?: () => void;
  /**
   * Retry and reply versions: Chat only. Cowork's toolbar is copy and the two
   * ratings.
   */
  versions?: boolean;
  /** Shared Chat row headings; independent legacy/Code actions retain their own entry. */
  contextualActions?: boolean;
  rating?: "up" | "down";
  onRating: (rating: "up" | "down" | null) => Promise<void>;
  onRetry: () => void;
  onSelect: (versionTurnId: string) => void;
  onError: (error: unknown) => void;
}) {
  const text = turn.items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text ?? "")
    .join("\n\n");
  const End = useTranscriptSlots().ReplyActionsEnd;
  const summary = contextualActions ? messageSummary(text) : "";
  const heading = summary
    ? formatText("Claudex responded: {summary}", { summary })
    : undefined;
  return (
    <div
      className="message-actions"
      role="toolbar"
      aria-label="Message actions"
    >
      <ShowMessageActions heading={heading} />
      <CopyButton
        iconOnly
        text={text}
        glyph={<ReplyCopyIcon />}
        message="reply"
      />
      <ReadAloud
        readKey={JSON.stringify([conversation.id, turn.id])}
        text={text}
      />
      {/* No ratings in an incognito chat (the original hides them in a temporary
         one). A chosen thumb is solid; pressing it again rates again, which
         opens the feedback dialog again rather than withdrawing the rating. */}
      {!conversation.incognito && (
        <>
          <ReplyToolbarButton
            label="Good response"
            pressed={rating === "up"}
            className="reply-rating"
            onClick={() => void onRating("up").catch(onError)}
          >
            <ReplyThumbUpIcon filled={rating === "up"} />
          </ReplyToolbarButton>
          <ReplyToolbarButton
            label="Bad response"
            pressed={rating === "down"}
            className="reply-rating"
            onClick={() => void onRating("down").catch(onError)}
          >
            <ReplyThumbDownIcon filled={rating === "down"} />
          </ReplyToolbarButton>
        </>
      )}
      {versions && (
        <ReplyVersions
          conversation={conversation}
          turn={turn}
          busy={busy}
          onRetry={onRetry}
          onSelect={onSelect}
        />
      )}
      {onSpinOff && <SpinOffMenu onSpinOff={onSpinOff} />}
      <RelativeTime createdAt={turn.createdAt} />
      {End && <End turn={turn} />}
    </div>
  );
}

/** A Cowork reply's More options. */
function SpinOffMenu({ onSpinOff }: { onSpinOff: () => void }) {
  const [menu, setMenu] = useState<MenuPosition>();
  const trigger = useRef<HTMLSpanElement>(null);
  return (
    <span ref={trigger} className="reply-more">
      <ReplyToolbarButton
        label="More options"
        pressed={menu ? true : undefined}
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          if (!rect || menu) return setMenu(undefined);
          setMenu({
            top: rect.bottom + 4,
            right: document.documentElement.clientWidth - rect.right,
          });
        }}
      >
        <AppIcon name="DotsHorizontal" />
      </ReplyToolbarButton>
      {menu && (
        <Menu
          label="More options"
          position={menu}
          width={220}
          anchors={[trigger]}
          entries={[
            {
              label: "Spin off a new task",
              icon: <AppIcon name="ArrowSplitRight" />,
              onSelect: onSpinOff,
            },
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </span>
  );
}

/**
 * A Code reply's toolbar: Copy, Fork and Pin, then the time. The latest reply
 * keeps its still star instead. Fork from here starts a new session continuing
 * after this reply ("Starts a new session, keeps this one"); pinning has no
 * Claudex counterpart yet, so it is greyed with why (read aloud was removed by
 * owner decision 19).
 */
export function CodeReplyToolbar({
  turn,
  onFork,
}: {
  turn: Turn;
  onFork?: () => void;
}) {
  const text = turn.items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text ?? "")
    .join("\n\n");
  return (
    <div
      className="message-actions code-reply-actions"
      role="toolbar"
      aria-label="Message actions"
    >
      <CopyButton
        iconOnly
        text={text}
        glyph={<ReplyCopyIcon />}
        message="reply"
      />
      <span title={onFork ? undefined : codeMenuReasons.fork}>
        <ReplyToolbarButton
          label="Fork from here"
          disabled={!onFork}
          onClick={() => onFork?.()}
        >
          <Split size={16} strokeWidth={1.5} />
        </ReplyToolbarButton>
      </span>
      <span title={notAvailable}>
        <ReplyToolbarButton
          label="Pin as chapter"
          pressed={false}
          disabled
          onClick={() => {}}
        >
          <Pin size={16} strokeWidth={1.5} />
        </ReplyToolbarButton>
      </span>
      <RelativeTime createdAt={turn.createdAt} />
    </div>
  );
}
