import { useState } from "react";
import type { Conversation } from "../../../shared/types";
import { t } from "../../i18n";
import { RelativeTime } from "../../ui/RelativeTime";
import { useSharedConversationIds } from "../shared/shared-ids";
import { ProjectChatRow } from "./ProjectChatRow";

/** Rows Recents shows before Show more, and how many each click adds. */
export const projectChatsPage = 20;
/** The longest preview of a task's first message, then an ellipsis. */
export const previewLimit = 120;

const collapsedKey = "claudex.project.pinnedCollapsed";

/** The task's first message as its row's second line (Cowork rows only). */
export function chatPreview(c: Pick<Conversation, "mode" | "turns">) {
  if (c.mode !== "cowork") return "";
  const text = (c.turns[0]?.prompt ?? "").replace(/\s+/g, " ").trim();
  return text.length > previewLimit ? `${text.slice(0, previewLimit)}…` : text;
}

/** Pinned rows go to their own section; the rest stay in Recents, in order. */
export function splitProjectChats(chats: readonly Conversation[]) {
  return {
    pinned: chats.filter((c) => c.pinned && !c.archived),
    recent: chats.filter((c) => !c.pinned || c.archived),
  };
}

function readCollapsed() {
  try {
    return localStorage.getItem(collapsedKey) === "1";
  } catch {
    return false;
  }
}

/** PinFilled, the icon font's xs (12px) glyph. */
function PinFilled() {
  return (
    <svg
      className="prj-chat-pin"
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="m10.26 4.26q.2.2.17.49q-.04.29-.29.45l-2.34 1.4q0 0 .05.18q.06.18.09.5q.04.33 0 .75q-.03.42-.2.9q-.17.48-.54.97l-5.1-5.1q.49-.37.97-.54q.48-.17.9-.2q.42-.04.75 0q.32.03.5.09q.18.05.18.05l1.4-2.34q.16-.25.45-.29q.29-.03.49.17zm-7.83 5.97q-.13.13-.33.13q-.19 0-.33-.13q-.13-.13-.13-.33q0-.19.13-.33l2.56-2.54q.13-.14.32-.14q.19 0 .32.14l2.15 2.14q.24-.42.31-.83q.08-.4.08-.72q0-.19-.02-.35q-.02-.17-.06-.28l-.07-.25l-.01-.14q0-.26.22-.39l2.34-1.41q.06-.04.07-.11q0-.06-.05-.1l-2.52-2.52q-.04-.06-.11-.05q-.06.01-.1.07l-1.41 2.34q-.13.23-.39.23h-.04l-.16-.05q-.2-.05-.4-.09q-.21-.03-.42-.03q-.34 0-.73.08q-.4.07-.82.31l2.14 2.15q.14.13.14.32q0 .19-.14.32q-.13.14-.32.14q-.19 0-.32-.14l-2.56-2.54q-.13-.15-.12-.36q.01-.21.17-.34q.5-.36.97-.54q.47-.19.87-.25q.41-.06.72-.06q.2 0 .4.02q.21.02.41.07l1.22-2.05q.18-.29.48-.41q.3-.12.62-.08q.32.05.56.28l2.52 2.52q.22.25.28.57q.05.31-.08.61q-.13.3-.41.48l-2.35 1.4q.22-.13.22-.39l-.01-.12l-.07-.13l-.07-.08q.1.08.14.2l.09.3q.03.16.06.37q.03.21.03.47q0 .31-.06.72q-.06.4-.24.88q-.19.47-.55.97q-.13.16-.34.17q-.2.02-.36-.12l-2.21-2.24z" />
    </svg>
  );
}

function Heading({
  label,
  collapsed,
  onToggle,
}: {
  label: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle) return <h2 className="prj-chats-heading">{t(label)}</h2>;
  return (
    <button
      type="button"
      className="prj-chats-toggle"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <h2 className="prj-chats-heading">{t(label)}</h2>
      <span className="prj-chats-toggle-hint">
        {collapsed ? t("Show") : t("Hide")}
      </span>
    </button>
  );
}

function ChatRow({
  chat: c,
  shared,
  onOpen,
}: {
  chat: Conversation;
  shared: boolean;
  onOpen: (c: Conversation) => void;
}) {
  const preview = chatPreview(c);
  return (
    <ProjectChatRow
      id={c.id}
      title={c.title}
      mode={c.mode}
      conversation={c}
      className="prj-chat-row"
      onOpen={() => onOpen(c)}
    >
      <span className="prj-chat-main">
        <span className="prj-chat-line">
          <span className="prj-chat-title" data-no-translate>
            {c.title || t("Untitled")}
          </span>
          {c.pinned && <PinFilled />}
          {shared && <span className="prj-chat-badge">{t("Shared")}</span>}
          {c.archived && (
            <span className="prj-chat-badge">{t("Archived")}</span>
          )}
        </span>
        {preview && (
          <span className="prj-chat-preview" data-no-translate>
            {preview}
          </span>
        )}
      </span>
      <RelativeTime createdAt={c.updatedAt} className="prj-chat-time" />
    </ProjectChatRow>
  );
}

/**
 * A project's chats (live claude.ai bundle, 2026-10-14, c71dee58b: the
 * space page's session table): Pinned, collapsible with Hide or Show on
 * hover, over Recents, which shows 20 rows and then Show more. A row is
 * at least 36px: its title, the pin glyph and a Shared badge, a Cowork
 * task's first message under it, and its last-message date at the end; rows are
 * parted by 1px hairlines.
 */
export function ProjectChats({
  chats,
  onOpen,
}: {
  chats: Conversation[];
  onOpen: (c: Conversation) => void;
}) {
  const shared = useSharedConversationIds(true);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [shown, setShown] = useState(projectChatsPage);
  const { pinned, recent } = splitProjectChats(chats);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey, next ? "1" : "0");
    } catch {
      // The section only forgets its state.
    }
  };
  const rows = (list: Conversation[]) => (
    <ul className="prj-chats-table">
      {list.map((c) => (
        <ChatRow
          key={c.id}
          chat={c}
          shared={shared.has(c.id)}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
  return (
    <div className="prj-chats">
      {pinned.length > 0 && (
        <section className="prj-chats-section">
          <Heading label="Pinned" collapsed={collapsed} onToggle={toggle} />
          {!collapsed && rows(pinned)}
        </section>
      )}
      {recent.length > 0 && (
        <section className="prj-chats-section">
          <Heading label="Recents" />
          {rows(recent.slice(0, shown))}
          {recent.length > shown && (
            <button
              type="button"
              className="prj-chats-more"
              onClick={() => setShown(shown + projectChatsPage)}
            >
              {t("Show more")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
