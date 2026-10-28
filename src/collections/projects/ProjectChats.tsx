import { Pin } from "lucide-react";
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

/** A filled pin at 12px (Lucide). */
function PinFilled() {
  return (
    <Pin
      className="prj-chat-pin"
      size={12}
      strokeWidth={1.75}
      fill="currentColor"
      aria-hidden="true"
    />
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
 * A project's chats: Pinned, collapsible with Hide or Show on hover, over
 * Recents, which shows 20 rows and then Show more. A row is at least 36px: its
 * title, the pin glyph and a Shared badge, a Cowork task's first message under
 * it, and its last-message date at the end; rows are parted by 1px hairlines.
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
