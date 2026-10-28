import type { KeyboardEvent } from "react";
import type { Conversation, Mode, Project } from "../../shared/types";
import type { PinReorder } from "./ConversationRow";
import { useEffect } from "react";
import { selection } from "./multi-select";
import { ConversationRow } from "./ConversationRow";
import { DragGhost } from "./DragGhost";
import { t, formatText } from "../i18n";
import {
  recentRowsShown,
  defaultFilter,
  isNestedSidebarRow,
} from "./listFilter";
import { emptyGroupsShown } from "./grouping";
import { rowBatch } from "./ConversationList";
import { Pin } from "../ui/glyphs";
import { recentsTitle } from "./recents-labels";
import { filterActive } from "./HistoryFilter";
import { conversationListView } from "./ConversationListView";
import type { ReorderInput } from "./ConversationList";
import type { TitleOfferResponse } from "../../shared/title-offers";
import type { AppController } from "../app/AppContext";
import type { CodeListView } from "./code-list-view";
import type { ConversationGroups } from "../../shared/collections-api";
import type { ConversationDrag } from "./useConversationDrag";
import type { ListFilter } from "./listFilter";
import type { GroupBy } from "./grouping";
import type { ToolSearchMode } from "../../shared/tool-search-mode";

/** What useConversationListActions needs from ConversationList.tsx. */
export interface UseConversationListActionsKit {
  actions: {
    onOpen: (c: Conversation) => void;
    onRename: (c: Conversation, title: string) => void;
    onMoveToProject: (c: Conversation, projectId: string | null) => void;
    onToggleArchive: (c: Conversation) => void;
    onDelete: (c: Conversation) => void;
    onToggleUnread: (c: Conversation) => void;
    onUpdateConversation?:
      | ((
          c: Conversation,
          patch: {
            sessionAuthors?:
              | { viewerAccountUuid: string; ownerAccountUuid: string }
              | null
              | undefined;
            title?: string | undefined;
            thinkingSummariesWanted?: boolean | undefined;
            thinkingMode?: "standard" | "extended" | undefined;
            pinned?: boolean | undefined;
            archived?: boolean | undefined;
            projectId?: string | null | undefined;
            unread?: boolean | undefined;
            connectorOverrides?: Record<string, boolean> | undefined;
            connectorToolOverrides?:
              | Readonly<Record<string, Readonly<Record<string, boolean>>>>
              | undefined;
            toolSearchMode?: ToolSearchMode | undefined;
            remoteControl?: boolean | undefined;
            codePermissionMode?:
              "auto" | "manual" | "acceptEdits" | "plan" | "bypass" | undefined;
            keepAwake?: boolean | undefined;
            prMerged?: boolean | undefined;
            prAutoFix?: { ci: boolean; comments: boolean } | undefined;
            prAutoArchive?: boolean | undefined;
            providerId?: string | undefined;
            model?: string | undefined;
            goal?:
              | {
                  condition: string;
                  setAt: number;
                  iterations: number;
                  lastReason?: string | undefined;
                }
              | null
              | undefined;
            outputStyle?: string | undefined;
            customOutputStyles?:
              Record<string, { name: string; prompt: string }> | undefined;
            cwd?: string | undefined;
            additionalFolders?: string[] | undefined;
            parentSessionId?: string | null | undefined;
            nestedSessionsHidden?: boolean | undefined;
            titleOffersSuppressed?: boolean | undefined;
            titleOffer?:
              { proposedTitle: string; at: number } | null | undefined;
            titleOfferResponse?: TitleOfferResponse | undefined;
            completedAt?: number | null | undefined;
            runnerReleasedAt?: number | null | undefined;
          },
        ) => void)
      | undefined;
    onOpenIn: (c: Conversation, target: "folder" | "terminal") => void;
    onOpenInWindow?: ((c: Conversation) => void) | undefined;
    onOpenInSplit?: ((c: Conversation) => void) | undefined;
    onShare?: ((c: Conversation) => void) | undefined;
    onDeleteMany?: ((ids: string[]) => void) | undefined;
  };
  activeId: string | undefined;
  announcement: string;
  app: AppController | undefined;
  approvalIds: ReadonlySet<string>;
  classify: boolean;
  codeView: CodeListView;
  collapsed: { pinned: boolean; recent: boolean };
  conversations: Conversation[];
  currentCodeList: boolean;
  customGroups: ConversationGroups;
  drag: ConversationDrag | undefined;
  dragControl: {
    drag: ConversationDrag | undefined;
    pointer: React.RefObject<{ x: number; y: number }>;
    scroll: React.RefObject<HTMLDivElement | null>;
    pointerDown: (
      event: React.PointerEvent<HTMLDivElement>,
      row: { id: string },
    ) => void;
    pointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    pointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    pointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
    lostCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
    click: (event: React.MouseEvent<HTMLElement, MouseEvent>) => boolean;
  };
  filter: ListFilter;
  groupBy: GroupBy;
  hold:
    | ConversationDrag
    | {
        id: string;
        landed: (list: Conversation[]) => boolean;
        release: () => void;
      }
    | undefined;
  hub: boolean;
  limit: { pinned: number; recent: number };
  list: React.RefObject<HTMLDivElement | null>;
  mode: Mode;
  namingFor: Conversation | Conversation[] | undefined;
  newSection: boolean;
  onError: (error: unknown) => void;
  onPageChange: (page: string) => void;
  onReorder: (input: ReorderInput) => Promise<void>;
  onSearch: (() => void) | undefined;
  page: string;
  pinTip: boolean;
  pinTipLoaded: boolean;
  pinned: Conversation[];
  pinnedHeading: React.RefObject<HTMLDivElement | null>;
  pinnedProjects: Project[];
  projects: Project[];
  recent: Conversation[];
  roving: {
    onFocus: (event: { target: EventTarget }) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
  scrollTimer: React.RefObject<NodeJS.Timeout | undefined>;
  setAnnouncement: React.Dispatch<React.SetStateAction<string>>;
  setCodeView: (next: CodeListView) => void;
  setCollapsed: React.Dispatch<
    React.SetStateAction<{ pinned: boolean; recent: boolean }>
  >;
  setFilter: React.Dispatch<React.SetStateAction<ListFilter>>;
  setLimit: React.Dispatch<
    React.SetStateAction<{ pinned: number; recent: number }>
  >;
  setNamingFor: React.Dispatch<
    React.SetStateAction<Conversation | Conversation[] | undefined>
  >;
  setNewSection: React.Dispatch<React.SetStateAction<boolean>>;
  setPinTip: React.Dispatch<React.SetStateAction<boolean>>;
  shownCodeView: CodeListView;
  shutGroups: ReadonlySet<string>;
  toggleGroup: (key: string) => void;
  togglePin: (c: Conversation) => void;
  unifiedChatList: boolean;
}

export function useConversationListActions(kit: UseConversationListActionsKit) {
  const {
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
  } = kit;
  /**
   * Ctrl+Alt+P (Cmd+Option+P on macOS) pins or unpins the focused row: the
   * original's "Pin / unpin session" key. `code`, because Option+P types
   * another character on macOS.
   */
  const keyboardPin = (event: KeyboardEvent<HTMLElement>, c: Conversation) => {
    if (!event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey))
      return;
    if (event.code !== "KeyP") return;
    event.preventDefault();
    // A held chord pins once.
    if (event.repeat) return;
    togglePin(c);
  };

  // Move up and Move down on a pinned Code row: one place along Pinned, as a
  // drop before the row above or after the row below.
  const pinReorderFor = (c: Conversation): PinReorder | undefined => {
    if (mode !== "code" || !c.pinned) return undefined;
    const index = pinned.findIndex((row) => row.id === c.id);
    if (index < 0) return undefined;
    const move = (targetId: string, position: "before" | "after") =>
      void onReorder({
        sourceId: c.id,
        targetId,
        section: "pinned",
        position,
      }).catch(onError);
    const above = pinned[index - 1];
    const below = pinned[index + 1];
    return {
      onMoveUp: above ? () => move(above.id, "before") : undefined,
      onMoveDown: below ? () => move(below.id, "after") : undefined,
    };
  };

  // Rows that leave the list leave the selection; another surface starts
  // with none.
  useEffect(() => {
    const listed = new Set(conversations.map((c) => c.id));
    selection.prune([...selection.get().keys].filter((id) => !listed.has(id)));
  }, [conversations]);
  useEffect(() => selection.clear(), [mode]);
  const rowsFor = (ids: ReadonlySet<string>) =>
    conversations.filter((c) => ids.has(c.id));
  const renderRow = (c: Conversation) => renderRowInGroup(c, false);
  const renderRowInGroup = (c: Conversation, hidePlace: boolean) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      projects={projects}
      selected={activeId === c.id && page === "chat"}
      needsApproval={approvalIds.has(c.id)}
      actions={{ ...actions, onTogglePin: togglePin }}
      onKeyboardPin={(event) => keyboardPin(event, c)}
      draggable={!c.archived}
      dragControl={dragControl}
      onNewGroup={setNamingFor}
      pinReorder={pinReorderFor(c)}
      showPrStatus={mode === "code" && filter.showPrStatus !== false}
      codeView={currentCodeList ? shownCodeView : undefined}
      ownSection={Boolean(customGroups.members[c.id])}
      hidePlace={currentCodeList && hidePlace}
      nested={isNestedSidebarRow(c, conversations)}
      rowsFor={rowsFor}
    />
  );
  // The copy of the dragged row that follows the pointer. Over a custom group
  // the copy reads where a release takes it.
  const ghost = drag && (
    <DragGhost
      ghost={drag.ghost}
      label={
        drag.group
          ? drag.group.id === null
            ? t("Ungroup")
            : formatText("Move to {label}", { label: drag.group.label })
          : drag.unpin
            ? "Release to unpin"
            : null
      }
      danger={drag.unpin}
      pointer={dragControl.pointer}
    />
  );
  // Rows past a section's limit wait behind Show more. A drag shows every
  // pinned row, as the drag measures them all.
  const pinnedShown = hold ? pinned : pinned.slice(0, limit.pinned);
  const recentShown = recent.slice(0, recentRowsShown(mode, limit.recent));
  // Custom groups with nothing in the list keep a heading when the surface
  // or Show empty groups says so (grouping.ts emptyGroupsShown).
  const showEmptyGroup =
    currentCodeList || groupBy === "custom"
      ? emptyGroupsShown(
          mode,
          currentCodeList
            ? codeView.emptyGroups
            : Boolean(filter.showEmptyGroups),
          new Set(recent.map((row) => customGroups.members[row.id] ?? "")),
          unifiedChatList,
        )
      : undefined;
  /**
   * "Show N more" while rows are held back, "Show less" once they are all out.
   */
  const showMore = (
    section: "pinned" | "recent",
    total: number,
    shownCount: number,
    bucket: string,
  ) => {
    const hidden = total - shownCount;
    if (hidden <= 0 && !(limit[section] > rowBatch && total > rowBatch))
      return null;
    const more = hidden > 0;
    const values = { count: Math.min(hidden, rowBatch), bucketLabel: bucket };
    return (
      <button
        className="view-all show-more"
        data-roving-item=""
        data-drag-shift=""
        aria-label={formatText(
          more
            ? "Show {count} more in {bucketLabel}"
            : "Show less in {bucketLabel}",
          values,
        )}
        onClick={() => {
          setLimit({
            ...limit,
            [section]: more ? limit[section] + rowBatch : rowBatch,
          });
          setAnnouncement(
            formatText(
              more
                ? "Showing {count} more in {bucketLabel}"
                : "Showing less in {bucketLabel}",
              values,
            ),
          );
        }}
      >
        {more ? formatText("Show {count} more", values) : "Show less"}
      </button>
    );
  };
  /**
   * The pinned rows. An empty section being dragged into says so (desktop
   * bundle 2.31226.1: the Pin row reading "Drop here", and "Let go" while a
   * release would pin); after the release the row stands on it until the list
   * has it. While the drag tip is up over an empty section, the row reads "Drag
   * to pin".
   */
  const pinnedList = () => (
    <div className="pinned-rows">
      {pinnedShown.map(renderRow)}
      {(hold || pinTip) && pinned.length === 0 && (
        <div
          className="pin-hint"
          data-hot={(drag && drag.slot !== null) || undefined}
          data-dragging={drag ? "" : undefined}
          data-dropped={(hold && !drag) || undefined}
          aria-hidden="true"
        >
          <Pin size={16} strokeWidth={1.5} />
          <span>
            {drag && drag.slot !== null
              ? "Let go"
              : hold
                ? "Drop here"
                : "Drag to pin"}
          </span>
        </div>
      )}
    </div>
  );
  // Stored Chat and Cowork records share the visible Recents section.
  const recentLabel = recentsTitle(mode, hub);
  // Code's list says why it is empty (the original's emptyVariant); Chat's
  // simply has no rows. Loading never fails here: the conversations are
  // read from this computer or the runner with the window.
  const empty =
    mode === "code" && recent.length === 0 ? (
      filterActive(filter) ? (
        <div className="sidebar-empty" role="status" data-drag-shift="">
          <span>No sessions match the current filters</span>
          <button
            className="sidebar-empty-action"
            data-roving-item=""
            onClick={() => setFilter(defaultFilter)}
          >
            Show all sessions
          </button>
        </div>
      ) : (
        pinned.length === 0 && (
          <div className="sidebar-empty" role="status" data-drag-shift="">
            Sessions you start will show up here
          </div>
        )
      )
    ) : null;
  const conversationListViewView = conversationListView({
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
    empty,
    filter,
    ghost,
    groupBy,
    hold,
    list,
    mode,
    namingFor,
    newSection,
    onError,
    onPageChange,
    onSearch,
    pinTip,
    pinTipLoaded,
    pinned,
    pinnedHeading,
    pinnedList,
    pinnedProjects,
    pinnedShown,
    recent,
    recentLabel,
    recentShown,
    renderRow,
    renderRowInGroup,
    roving,
    scrollTimer,
    setCodeView,
    setCollapsed,
    setFilter,
    setNamingFor,
    setNewSection,
    setPinTip,
    showEmptyGroup,
    showMore,
    shownCodeView,
    shutGroups,
    toggleGroup,
    unifiedChatList,
  });
  return { conversationListViewView } as const;
}
