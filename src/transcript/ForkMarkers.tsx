import { useRef, useState } from "react";
import { RotateCcw } from "../ui/glyphs";
import type { Conversation, ConversationRewind } from "../../shared/types";
import { Menu, type MenuPosition } from "../ui/Menu";
import { currentLocale, formatText } from "../i18n";
import { WithTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";

/*
 * Where a forked conversation came from, and where others were forked from this
 * one.
 */

type Lookup = (id: string) => Conversation | undefined;

/** "Forked from {title}" above a forked conversation's first turn. */
export function ForkedFrom({
  conversation,
  lookup,
  onOpen,
}: {
  conversation: Conversation;
  lookup: Lookup;
  onOpen: (conversation: Conversation) => void;
}) {
  const source = conversation.forkedFrom;
  if (!source) return null;
  const parent = lookup(source.conversationId);
  const title = parent?.title ?? source.title;
  const body = (
    <>
      <AppIcon name="ArrowSplitRight" />
      <span>
        {title
          ? formatText("Forked from {title}", { title })
          : "Forked from another session"}
      </span>
    </>
  );
  return (
    <div className="fork-marker fork-source">
      {parent ? (
        <button
          type="button"
          aria-label={formatText("Go to parent session {title}", { title })}
          onClick={() => onOpen(parent)}
        >
          {body}
        </button>
      ) : (
        <span>{body}</span>
      )}
    </div>
  );
}

/** The forks taken after a turn, under it. */
export function ForksHere({
  conversation,
  turnId,
  lookup,
  onOpen,
}: {
  conversation: Conversation;
  turnId: string;
  lookup: Lookup;
  onOpen: (conversation: Conversation) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const forks = (conversation.forks ?? [])
    .filter((fork) => fork.turnId === turnId)
    .map((fork) => lookup(fork.conversationId))
    .filter((fork): fork is Conversation => Boolean(fork));
  if (!forks.length) return null;
  const titleOf = (fork: Conversation) => fork.title || "Untitled session";
  if (forks.length === 1) {
    const [fork] = forks;
    const body = (
      <>
        <AppIcon name="ArrowSplitRight" />
        <span>
          {formatText("Forked here: {title}", { title: titleOf(fork) })}
        </span>
        {fork.archived && (
          <span className="fork-archived">
            · <span>Archived</span>
          </span>
        )}
      </>
    );
    return (
      <div className="fork-marker" data-testid="fork-marker">
        {fork.archived ? (
          <span>{body}</span>
        ) : (
          <button type="button" onClick={() => onOpen(fork)}>
            {body}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="fork-marker" data-testid="fork-marker">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={(event) => {
          if (menu) return setMenu(undefined);
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ left: box.left, top: box.bottom + 4 });
        }}
      >
        <AppIcon name="ArrowSplitRight" />
        <span>
          {formatText("{count} forks from here", { count: forks.length })}
        </span>
      </button>
      {menu && (
        <Menu
          label="Forks from here"
          position={menu}
          width={240}
          anchors={[trigger]}
          entries={forks.map((fork) => ({
            label: titleOf(fork),
            disabled: fork.archived,
            ...(fork.archived ? { title: "Archived" } : {}),
            onSelect: () => onOpen(fork),
          }))}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

/**
 * Where a rewind cut the conversation: "Rewound here · {time}" with Undo
 * rewind, or after an undo "Rewind undone · {time}" with Redo rewind; the
 * button's tooltip says what it brings back.
 */
export function RewindMarker({
  rewind,
  busy,
  onSwap,
}: {
  rewind: ConversationRewind;
  busy: boolean;
  onSwap: () => void;
}) {
  const forward = rewind.variant === "forward";
  const at = new Date(rewind.at).toLocaleTimeString(currentLocale(), {
    hour: "numeric",
    minute: "2-digit",
  });
  const detail = forward
    ? "Brings back the messages Undo rewind set aside. The ones from here on are set aside for Undo rewind. Your files stay as they are."
    : "Brings back the messages this rewind removed. Your files stay as they are. Undo works until you send your next message.";
  return (
    <div className="fork-marker rewind-marker" data-testid="rewind-marker">
      <span>
        <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
        <span>{forward ? "Rewind undone" : "Rewound here"}</span>
        <span className="fork-archived">· {at}</span>
      </span>
      <WithTooltip label={detail} disabled={busy}>
        {(props) => (
          <button {...props} type="button" disabled={busy} onClick={onSwap}>
            {forward ? "Redo rewind" : "Undo rewind"}
          </button>
        )}
      </WithTooltip>
    </div>
  );
}
