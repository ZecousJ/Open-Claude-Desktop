import {
  groupMs,
  PinnedProjects,
  GroupHeader,
  DragPinTip,
  GroupNameDialog,
} from "./ConversationList";
import {
  SectionLabel,
  CodeRecentSortSlot,
  GroupLabel,
} from "./ConversationListLabels";
import { Collapsible } from "../ui/Collapsible";
import { Suspense } from "react";
import { surface } from "../../shared/host";
import { AppIcon } from "../ui/app-icon";
import { CodeListMenu } from "./CodeListMenu";
import { HistoryFilter } from "./HistoryFilter";
import { codeListGroups } from "./code-list-view";
import {
  groupRows,
  keepGroupWhileEmpty,
  setConversationGroups,
} from "./grouping";
import { dragPinTipText, markDragPinTipSeen } from "./drag-pin-tip";
import { createPortal } from "react-dom";
import type { Conversation, Mode, Project } from "../../shared/types";
import type { AppController } from "../app/AppContext";
import type { CodeListView } from "./code-list-view";
import type { ConversationGroups } from "../../shared/collections-api";
import type { ConversationDrag } from "./useConversationDrag";
import type { ListFilter } from "./listFilter";
import type { GroupBy } from "./grouping";

/** What conversationListView needs from ConversationList.tsx. */
export interface ConversationListViewKit {
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
  empty: false | React.JSX.Element | null;
  filter: ListFilter;
  ghost: React.JSX.Element | undefined;
  groupBy: GroupBy;
  hold:
    | ConversationDrag
    | {
        id: string;
        landed: (list: Conversation[]) => boolean;
        release: () => void;
      }
    | undefined;
  list: React.RefObject<HTMLDivElement | null>;
  mode: Mode;
  namingFor: Conversation | Conversation[] | undefined;
  newSection: boolean;
  onError: (error: unknown) => void;
  onPageChange: (page: string) => void;
  onSearch: (() => void) | undefined;
  pinTip: boolean;
  pinTipLoaded: boolean;
  pinned: Conversation[];
  pinnedHeading: React.RefObject<HTMLDivElement | null>;
  pinnedList: () => React.JSX.Element;
  pinnedProjects: Project[];
  pinnedShown: Conversation[];
  recent: Conversation[];
  recentLabel: string;
  recentShown: Conversation[];
  renderRow: (c: Conversation) => React.JSX.Element;
  renderRowInGroup: (c: Conversation, hidePlace: boolean) => React.JSX.Element;
  roving: {
    onFocus: (event: { target: EventTarget }) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
  scrollTimer: React.RefObject<NodeJS.Timeout | undefined>;
  setCodeView: (next: CodeListView) => void;
  setCollapsed: React.Dispatch<
    React.SetStateAction<{ pinned: boolean; recent: boolean }>
  >;
  setFilter: React.Dispatch<React.SetStateAction<ListFilter>>;
  setNamingFor: React.Dispatch<
    React.SetStateAction<Conversation | Conversation[] | undefined>
  >;
  setNewSection: React.Dispatch<React.SetStateAction<boolean>>;
  setPinTip: React.Dispatch<React.SetStateAction<boolean>>;
  showEmptyGroup: ((groupId: string) => boolean) | undefined;
  showMore: (
    section: "pinned" | "recent",
    total: number,
    shownCount: number,
    bucket: string,
  ) => React.JSX.Element | null;
  shownCodeView: CodeListView;
  shutGroups: ReadonlySet<string>;
  toggleGroup: (key: string) => void;
  unifiedChatList: boolean;
}

export function conversationListView(kit: ConversationListViewKit) {
  const {
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
  } = kit;
  const pinnedStub =
    pinned.length === 0 && pinnedProjects.length === 0 && !hold && !pinTip;
  const conversationListViewView = (
    <div
      ref={(el) => {
        list.current = el;
        dragControl.scroll.current = el;
      }}
      className={`sidebar-scroll u-scroll-fade-y ${drag ? "is-dragging-row" : ""}`}
      data-mode={mode === "code" ? "code" : undefined}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      onScroll={(event) => {
        const list = event.currentTarget;
        list.dataset.scrolling = "true";
        clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(
          () => delete list.dataset.scrolling,
          1000,
        );
      }}
    >
      {/* With nothing pinned (and no drag or pin tip under way) the section
         folds to nothing. */}
      <div
        className="pinned-section"
        data-drop-section="pinned"
        data-roving-block=""
        data-stub={pinnedStub || undefined}
        inert={pinnedStub || undefined}
      >
        <SectionLabel
          label="Pinned"
          labelRef={pinnedHeading}
          collapsed={collapsed.pinned}
          onToggle={() =>
            setCollapsed((current) => ({
              ...current,
              pinned: !current.pinned,
            }))
          }
        />
        <Collapsible
          open={!collapsed.pinned}
          className="sidebar-group-rows"
          exitMs={groupMs}
        >
          {/* The rows open when the first one arrives, or a drag brings one. */}
          <div
            className="pinned-reveal u-expand-rows"
            data-open={
              pinned.length > 0 ||
              pinnedProjects.length > 0 ||
              Boolean(hold) ||
              pinTip
            }
          >
            {pinnedProjects.length > 0 && (
              <Suspense fallback={null}>
                <PinnedProjects
                  projects={pinnedProjects}
                  conversations={conversations}
                  renderConversation={renderRow}
                />
              </Suspense>
            )}
            {pinnedList()}
          </div>
          {showMore("pinned", pinned.length, pinnedShown.length, "Pinned")}
        </Collapsible>
      </div>
      <div data-drop-section="recent" data-roving-block="">
        <SectionLabel
          className="recent-label"
          label={recentLabel}
          collapsed={collapsed.recent}
          onToggle={() =>
            setCollapsed((current) => ({
              ...current,
              recent: !current.recent,
            }))
          }
        >
          {surface === "web" && mode !== "code" && (
            <button
              className="recents-view-all"
              aria-label="View all"
              onClick={() => onPageChange("history")}
            >
              <AppIcon name="ArrowUpRight" size={16} />
            </button>
          )}
          {surface !== "web" && mode !== "code" && onSearch && (
            <button
              className="recents-search"
              aria-label="Search"
              onClick={onSearch}
            >
              <AppIcon name="Search" />
            </button>
          )}
          <CodeRecentSortSlot collapsed={mode === "code"}>
            {currentCodeList ? (
              <CodeListMenu
                value={shownCodeView}
                onChange={setCodeView}
                classify={classify}
                onNewSection={() => setNewSection(true)}
                onViewAll={() => onPageChange("history")}
              />
            ) : (
              <HistoryFilter
                mode={mode}
                value={filter}
                onChange={setFilter}
                buttonLabel="Filter and group recents"
                unifiedChat={unifiedChatList}
                emptyGroups
                prStatus
              />
            )}
          </CodeRecentSortSlot>
          {/* "+" starts a session from the heading on every surface. */}
          {mode === "code" && app && (
            <button
              className="code-recents-new"
              aria-label="New session"
              onClick={() => app.newChat("code")}
            >
              <AppIcon name="Plus" size={16} />
            </button>
          )}
        </SectionLabel>
        <Collapsible
          open={!collapsed.recent}
          className="sidebar-group-rows"
          exitMs={groupMs}
        >
          {(currentCodeList
            ? codeListGroups(
                recentShown,
                codeView,
                customGroups,
                showEmptyGroup!,
                approvalIds,
                classify,
              )
            : groupRows(
                recentShown,
                groupBy,
                undefined,
                customGroups,
                showEmptyGroup,
                approvalIds,
              )
          ).map((group) => {
            if (!group.label)
              return (
                <div
                  key={group.key}
                  data-drop-group={currentCodeList ? "" : undefined}
                  data-group-label={currentCodeList ? "Ungrouped" : undefined}
                >
                  {group.rows.map(renderRow)}
                </div>
              );
            // Code's headings show and hide their rows at once.
            const toggle =
              mode === "code"
                ? {
                    collapsed: shutGroups.has(group.key),
                    onToggle: () => toggleGroup(group.key),
                  }
                : {};
            // A custom group (and Ungrouped) takes a dragged row.
            const dropGroup =
              currentCodeList || groupBy === "custom"
                ? group.key === "ungrouped"
                  ? ""
                  : group.key.startsWith("group:")
                    ? group.key.slice("group:".length)
                    : undefined
                : undefined;
            const target = drag?.group;
            const dropHot =
              dropGroup !== undefined &&
              Boolean(target) &&
              (target?.id ?? "") === dropGroup;
            return (
              <div
                key={group.key}
                className="row-group"
                role="group"
                aria-label={group.label}
                data-drop-group={dropGroup}
                data-group-label={
                  dropGroup !== undefined ? group.label : undefined
                }
              >
                {/* Folder and custom group names are names, not interface. */}
                {(currentCodeList || groupBy === "custom") &&
                group.key.startsWith("group:") ? (
                  <Suspense
                    fallback={
                      <GroupLabel label={group.label} noTranslate {...toggle} />
                    }
                  >
                    <GroupHeader
                      label={group.label}
                      groupId={group.key.slice("group:".length)}
                      members={
                        Object.values(customGroups.members).filter(
                          (id) => `group:${id}` === group.key,
                        ).length
                      }
                      list={list}
                      section={currentCodeList}
                      {...toggle}
                    />
                  </Suspense>
                ) : (
                  <GroupLabel
                    label={group.label}
                    noTranslate={
                      ("noTranslate" in group && Boolean(group.noTranslate)) ||
                      groupBy === "folder" ||
                      (groupBy === "custom" && group.key !== "ungrouped")
                    }
                    {...toggle}
                  />
                )}
                {!toggle.collapsed &&
                  group.rows.map((c) =>
                    renderRowInGroup(
                      c,
                      "hidePlace" in group && Boolean(group.hidePlace),
                    ),
                  )}
                {!toggle.collapsed &&
                  group.rows.length === 0 &&
                  group.key.startsWith("group:") && (
                    // An empty custom group says how to fill it.
                    <p className="row-group-hint" data-drag-shift="">
                      Drag or move sessions here
                    </p>
                  )}
                {dropGroup !== undefined && (
                  <div
                    className="row-group-drop"
                    data-hot={dropHot || undefined}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
          {empty}
          {mode === "code" &&
            showMore("recent", recent.length, recentShown.length, recentLabel)}
          {recent.length > 0 && surface !== "web" && (
            <button
              className="view-all"
              data-roving-item=""
              data-drag-shift=""
              onClick={() => onPageChange("history")}
            >
              View all
            </button>
          )}
        </Collapsible>
      </div>
      {ghost}
      {pinTipLoaded && (
        <Suspense fallback={null}>
          <DragPinTip
            open={pinTip}
            anchor={pinnedHeading}
            text={dragPinTipText(mode)}
            onClose={() => {
              markDragPinTipSeen();
              setPinTip(false);
            }}
          />
        </Suspense>
      )}
      {(namingFor || newSection) &&
        // Out of the list: its mask would cut the dialog to the list's box.
        createPortal(
          <Suspense fallback={null}>
            <GroupNameDialog
              title={currentCodeList ? "New section" : "New group"}
              section={currentCodeList}
              confirm={
                currentCodeList
                  ? "Create section"
                  : groupBy === "custom"
                    ? "Create group"
                    : "Create and group by custom"
              }
              note={
                currentCodeList || groupBy === "custom"
                  ? undefined
                  : "The list will switch to Custom groups to show it."
              }
              onSubmit={async (name) => {
                // One row (its menu) or several (the menu over a selection).
                const moving = namingFor
                  ? Array.isArray(namingFor)
                    ? namingFor
                    : [namingFor]
                  : [];
                let next = await window.desktop.createConversationGroup(
                  name,
                  moving[0]?.id,
                );
                const added = next.groups.find(
                  (g) => !customGroups.groups.some((old) => old.id === g.id),
                );
                for (const row of moving.slice(1))
                  if (added)
                    next = await window.desktop.moveConversationToGroup(
                      row.id,
                      added.id,
                    );
                // The groups they left stay in view, empty or not.
                for (const row of moving) {
                  const left = customGroups.members[row.id];
                  if (left) keepGroupWhileEmpty(left);
                }
                setConversationGroups(next);
                if (added) keepGroupWhileEmpty(added.id);
                if (!currentCodeList && groupBy !== "custom")
                  setFilter((current) => ({ ...current, groupBy: "custom" }));
              }}
              onError={onError}
              onClose={() => {
                setNamingFor(undefined);
                setNewSection(false);
              }}
            />
          </Suspense>,
          document.body,
        )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
  return conversationListViewView;
}
