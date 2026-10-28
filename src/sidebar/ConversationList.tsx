import {
  useEffect,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Conversation, Mode, Project } from "../../shared/types";
import type {
  DropPosition,
  SidebarSection,
} from "../../shared/conversation-order";
import { AppContext } from "../app/AppContext";
import { type RowActions } from "./ConversationRow";
import {
  defaultFilter,
  sidebarRowBatch,
  pinnedRows,
  recentRows,
} from "./listFilter";
import {
  currentConversationGroups,
  effectiveGroupBy,
  keepGroupWhileEmpty,
  reloadConversationGroups,
  setConversationGroups,
  useConversationGroups,
} from "./grouping";
import { useRovingFocus } from "./roving";
import { formatText, t } from "../i18n";
import { showToast } from "../ui/toast-store";
import { useConversationDrag } from "./useConversationDrag";
import { dragPinTipSeen, offersDragPinTip } from "./drag-pin-tip";
import { lazyPiece } from "../ui/lazy-piece";
import { useHost } from "../host/HostContext";
import { coworkAvailable } from "../home/home-mode";
import { codeListRows, useCodeListView } from "./code-list-view";
import { useChatListFilter } from "./chat-list-filter";
import { useConversationListActions } from "./useConversationListActions";

// A custom group's heading menu and the group name dialog are loaded when a
// custom group or "New group…" first needs them.
export const GroupHeader = lazyPiece(
  () => import("./GroupHeader"),
  "GroupHeader",
);
export const PinnedProjects = lazyPiece(
  () => import("./PinnedProjects"),
  "PinnedProjects",
);
export const GroupNameDialog = lazyPiece(
  () => import("./GroupNameDialog"),
  "GroupNameDialog",
);
// The one-time drag tip beside Pinned, loaded the first time a pin asks for it.
export const DragPinTip = lazyPiece(
  () => import("./DragPinTip"),
  "DragPinTip",
  {
    silent: true,
  },
);

/**
 * Rows a section shows. Pinned and Code's recents show 20, then "Show N more"
 * reveals 20 at a time (the pinned list's and Code's truncateAt of 20). Chat's
 * recents are capped at 20 with no Show more; View all opens the rest, as the
 * Chats and tasks list behind the search panel shows.
 */
export const rowBatch = sidebarRowBatch;

export type ReorderInput = {
  sourceId: string;
  targetId?: string;
  section: SidebarSection;
  position: DropPosition;
};

/**
 * A section opens and closes over 150ms on the CSS ease-out curve, as the
 * original's sidebar groups do.
 */
export const groupMs = 150;

/**
 * Pinned and recent conversations. The Pinned section is always there; a row
 * dragged over it is pinned where it is dropped, and a pinned row released
 * anywhere else is unpinned. Recents keep their order by activity. Grouped by
 * custom groups, a row dragged over a group (or Ungrouped) moves there on
 * release, as Move to group does. Ctrl+Alt+P pins or unpins the focused row.
 */
export function ConversationList({
  conversations,
  projects,
  activeId,
  page,
  mode,
  approvalIds,
  onPageChange,
  onSearch,
  onReorder,
  onError,
  pinTipAllowed = true,
  ...actions
}: {
  conversations: Conversation[];
  projects: Project[];
  activeId?: string;
  page: string;
  mode: Mode;
  /** Conversations with a request waiting for approval. */
  approvalIds: ReadonlySet<string>;
  onPageChange: (page: string) => void;
  onSearch?: () => void;
  onReorder: (input: ReorderInput) => Promise<void>;
  onError: (error: unknown) => void;
  /**
   * The sidebar is open as a column, so a pin from a row's menu may show the
   * drag tip (not while it peeks out collapsed or is hidden).
   */
  pinTipAllowed?: boolean;
} & Omit<RowActions, "onTogglePin">) {
  const hub = coworkAvailable(useHost());
  const app = useContext(AppContext);
  const currentCodeList = mode === "code";
  const unifiedChatList = mode !== "code" && Boolean(app);
  const [codeView, setCodeView] = useCodeListView(app?.accountId ?? "");
  const classify = app?.snapshot?.settings?.classifySessionStates !== false;
  const shownCodeView =
    codeView.groupBy === "status" && !classify
      ? { ...codeView, groupBy: "date" as const }
      : codeView;
  // Chat/Cowork keep their filter, across starts too (chat-list-filter.ts);
  // Code owns its separate persisted view.
  const [chatFilter, setFilter] = useChatListFilter(app?.accountId ?? "");
  const filter = currentCodeList ? defaultFilter : chatFilter;
  const [collapsed, setCollapsed] = useState({ pinned: false, recent: false });
  // Code's group headings that are shut, by group key.
  const [shutGroups, setShutGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleGroup = (key: string) =>
    setShutGroups((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const [announcement, setAnnouncement] = useState("");
  // How many rows each section shows; Show more adds a batch.
  const [limit, setLimit] = useState({ pinned: rowBatch, recent: rowBatch });
  useEffect(
    () =>
      setLimit((current) =>
        current.pinned === rowBatch && current.recent === rowBatch
          ? current
          : { pinned: rowBatch, recent: rowBatch },
      ),
    [mode, filter],
  );
  // "New group…" from a row's menu asks for the name in a dialog.
  const [namingFor, setNamingFor] = useState<Conversation | Conversation[]>();
  const [newSection, setNewSection] = useState(false);
  // The list's scrollbar shows only while it scrolls.
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  // The bar itself takes room from the rows while the list overflows; the
  // overlay bar of the original does not, so the list gives that room back.
  const list = useRef<HTMLDivElement>(null);
  const roving = useRovingFocus(list);
  const measureGutter = () => {
    const el = list.current;
    if (el)
      el.style.setProperty(
        "--list-gutter",
        `${Math.max(0, el.offsetWidth - el.clientWidth)}px`,
      );
  };
  useEffect(measureGutter);
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureGutter);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const recent = currentCodeList
    ? codeListRows(conversations, codeView)
    : recentRows(conversations, mode, filter);
  const pinned = pinnedRows(conversations, mode);
  const pinnedProjects =
    mode === "code"
      ? []
      : projects.filter((project) => project.pinned && !project.archivedAt);
  const groupBy = effectiveGroupBy(mode, filter.groupBy);
  const customGroups = useConversationGroups();
  // A release into Pinned shows the row in its new place at once, and the list
  // stands so until the reordered list arrives; `landed` tells when it has, and
  // `release` puts the list back to its layout.
  const [pending, setPending] = useState<{
    id: string;
    landed: (list: Conversation[]) => boolean;
    release: () => void;
  }>();
  /**
   * A release over a custom group: the row shows in the group at once, a shut
   * heading opens to show it, and the group it left keeps its heading while
   * empty. A pinned row is unpinned on the way, as the original's assignment
   * does; its place stays empty until the list without its pin arrives.
   */
  const dropIntoGroup = (
    source: Conversation,
    groupId: string | null,
    label: string,
    release: () => void,
  ) => {
    const before = currentConversationGroups();
    const left = before.members[source.id];
    const members = { ...before.members };
    if (groupId) members[source.id] = groupId;
    else delete members[source.id];
    if (left && left !== groupId) keepGroupWhileEmpty(left);
    setConversationGroups({ ...before, members });
    const heading = groupId ? `group:${groupId}` : "ungrouped";
    setShutGroups((current) => {
      if (!current.has(heading)) return current;
      const next = new Set(current);
      next.delete(heading);
      return next;
    });
    const unpin = source.pinned && groupId !== null;
    const settle = () => {
      release();
      setPending((current) =>
        current?.release === release ? undefined : current,
      );
    };
    if (unpin)
      setPending({
        id: source.id,
        landed: (list) => !list.find((item) => item.id === source.id)?.pinned,
        release,
      });
    else release();
    void Promise.all([
      window.desktop
        .moveConversationToGroup(source.id, groupId)
        .then(setConversationGroups),
      unpin
        ? onReorder({
            sourceId: source.id,
            section: "recent",
            position: "before",
          })
        : undefined,
    ])
      .then(() => {
        if (unpin) setTimeout(settle, 1000);
        setAnnouncement(
          formatText("{name} moved to {group}", {
            name: source.title,
            group: groupId ? label : t("Ungrouped"),
          }),
        );
      })
      .catch((error: unknown) => {
        if (unpin) settle();
        // What the store holds now, not the move shown in advance.
        void reloadConversationGroups();
        onError(error);
      });
  };
  const dragControl = useConversationDrag((sourceId, action, release) => {
    const source = conversations.find((item) => item.id === sourceId);
    if (!source) return release();
    if (action.kind === "group")
      return dropIntoGroup(source, action.groupId, action.label, release);
    const drop: ReorderInput =
      action.kind === "unpin"
        ? { sourceId, section: "recent", position: "before" }
        : { sourceId, ...action.target };
    const order = pinned.map((row) => row.id).join("\n");
    const landed = (list: Conversation[]) => {
      const row = list.find((item) => item.id === sourceId);
      if (!row) return true;
      if (action.kind === "unpin") return !row.pinned;
      if (!row.pinned) return false;
      return (
        action.kind === "pin" ||
        pinnedRows(list, mode)
          .map((item) => item.id)
          .join("\n") !== order
      );
    };
    setPending({ id: sourceId, landed, release });
    // Where an unpinned row goes back to if the toast's Undo is pressed.
    const at = pinned.findIndex((row) => row.id === sourceId);
    const restore: ReorderInput | undefined =
      action.kind === "unpin"
        ? pinned[at + 1]
          ? {
              sourceId,
              targetId: pinned[at + 1].id,
              section: "pinned",
              position: "before",
            }
          : pinned[at - 1]
            ? {
                sourceId,
                targetId: pinned[at - 1].id,
                section: "pinned",
                position: "after",
              }
            : { sourceId, section: "pinned", position: "before" }
        : undefined;
    const settle = () => {
      release();
      setPending((current) =>
        current?.release === release ? undefined : current,
      );
    };
    void onReorder(drop)
      .then(() => {
        // The list normally lands first (the layout effect below); one that
        // came back unchanged stands down after a moment.
        setTimeout(settle, 1000);
        setAnnouncement(
          `${source.title} ${
            action.kind === "unpin"
              ? "removed from Pinned"
              : action.kind === "reorder"
                ? "reordered in Pinned"
                : "moved to Pinned"
          }`,
        );
        // A drag out of Pinned says so, and can be taken back (desktop
        // bundle 2.31226.1: onDragUnpin's "Unpinned {name}" with Undo).
        if (restore)
          showToast(formatText("Unpinned {name}", { name: source.title }), {
            action: {
              label: "Undo",
              onSelect: () => void onReorder(restore).catch(onError),
            },
          });
      })
      .catch((error: unknown) => {
        settle();
        onError(error);
      });
  });
  // The reordered list has come: back to its layout before it paints.
  useLayoutEffect(() => {
    if (!pending?.landed(conversations)) return;
    pending.release();
    setPending(undefined);
  }, [conversations, pending]);
  const { drag } = dragControl;
  // What the list makes room for: the drag, or the drop it waits on.
  const hold = drag ?? pending;
  // The drag tip beside Pinned (drag-pin-tip.ts): asked for by a pin from a
  // row's menu or the keyboard, kept loaded once it has been.
  const [pinTip, setPinTip] = useState(false);
  const [pinTipLoaded, setPinTipLoaded] = useState(false);
  const pinnedHeading = useRef<HTMLDivElement>(null);
  // Hiding the sidebar takes the tip away without marking it seen.
  useEffect(() => {
    if (!pinTipAllowed) setPinTip(false);
  }, [pinTipAllowed]);
  const togglePin = (c: Conversation) => {
    if (
      offersDragPinTip({
        pinning: !c.pinned,
        seen: dragPinTipSeen(),
        sidebarShown: pinTipAllowed,
        width: window.innerWidth,
      })
    ) {
      setPinTip(true);
      setPinTipLoaded(true);
    }
    void onReorder({
      sourceId: c.id,
      section: c.pinned ? "recent" : "pinned",
      position: "before",
    })
      .then(() =>
        setAnnouncement(
          `${c.title} ${c.pinned ? "removed from Pinned" : "moved to Pinned"}`,
        ),
      )
      .catch(onError);
  };
  const { conversationListViewView } = useConversationListActions({
    actions,
    activeId,
    announcement,
    app,
    approvalIds,
    classify,
    codeView,
    collapsed,
    conversations,
    currentCodeList,
    customGroups,
    drag,
    dragControl,
    filter,
    groupBy,
    hold,
    hub,
    limit,
    list,
    mode,
    namingFor,
    newSection,
    onError,
    onPageChange,
    onReorder,
    onSearch,
    page,
    pinTip,
    pinTipLoaded,
    pinned,
    pinnedHeading,
    pinnedProjects,
    projects,
    recent,
    roving,
    scrollTimer,
    setAnnouncement,
    setCodeView,
    setCollapsed,
    setFilter,
    setLimit,
    setNamingFor,
    setNewSection,
    setPinTip,
    shownCodeView,
    shutGroups,
    toggleGroup,
    togglePin,
    unifiedChatList,
  });
  return conversationListViewView;
}
