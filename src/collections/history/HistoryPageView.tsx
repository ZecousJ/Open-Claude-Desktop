import { CollectionHeader, PrimaryAction } from "../CollectionHeader";
import { formatText, currentLocale, t } from "../../i18n";
import { HistoryTabs, SearchSortButton } from "./HistoryControls";
import {
  PinOff,
  Pin,
  Eye,
  EyeOff,
  Archive,
  Trash2,
  X,
  Check,
  EllipsisVertical,
} from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { PageSearchIcon, SearchIcon } from "../../ui/icons";
import {
  rangeSelection,
  historyNeedsAttention,
  historyTabEmptyText,
} from "./history-rows";
import { HistoryRowText, HistoryRepositoryText } from "./HistoryPage";
import { collectionTime } from "../collection-time";
import { PageMenu } from "../PageMenu";
import type { Conversation, Mode } from "../../../shared/types";
import type { PageMenuEntry } from "../PageMenu";
import type { HistorySearchSort, HistoryTab } from "./history-rows";
import type { RowGroup } from "../../sidebar/grouping";
import type { HostInfo } from "../../../shared/host";

/** What historyPageView needs from HistoryPage.tsx. */
export interface HistoryPageViewKit {
  actions: {
    pinned: boolean;
    pin: Conversation[];
    unread: boolean;
    read: Conversation[];
    movable: Conversation[];
    project: boolean;
  };
  allArchived: boolean;
  anchor: React.RefObject<string | undefined>;
  approvalIds: ReadonlySet<string>;
  archive: () => Promise<void>;
  busy: boolean;
  chosen: Conversation[];
  endSelection: () => void;
  groups: RowGroup[];
  headingId: string;
  host: HostInfo;
  kind: "both";
  labels: {
    title: string;
    searchPlaceholder: string;
    searchLabel: string;
    newLabel: string;
  };
  loading: boolean;
  mode: Mode;
  more: React.RefObject<HTMLDivElement | null>;
  noun: "chat" | "session";
  now: number;
  onDelete: (ids: string[], done: (failed: string[]) => void) => void;
  onMoveToProject:
    | ((rows: Conversation[], done: (failed: string[]) => void) => void)
    | undefined;
  onNewChat: () => void;
  onOpenConversation: (conversation: Conversation) => void;
  order: string[];
  query: string | null;
  retrySearch: () => void;
  rowEntries: (c: Conversation) => PageMenuEntry[];
  rowMenu: Conversation | undefined;
  rowMenuAnchor: React.RefObject<HTMLElement | null>;
  rows: Conversation[];
  searchError: boolean;
  searchQuery: string;
  searchSort: HistorySearchSort;
  selected: Set<string>;
  selecting: boolean;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setRowMenu: React.Dispatch<React.SetStateAction<Conversation | undefined>>;
  setSearchSort: React.Dispatch<React.SetStateAction<HistorySearchSort>>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSelecting: React.Dispatch<React.SetStateAction<boolean>>;
  setTab: React.Dispatch<React.SetStateAction<HistoryTab>>;
  settle: (failed: string[]) => void;
  shared: ReadonlySet<string>;
  shown: number;
  snippets: Map<string, string | undefined>;
  tab: HistoryTab;
  tabsId: string;
  title: string;
  updateSelection: (
    ids: string[],
    patch: { pinned?: boolean | undefined; unread?: boolean | undefined },
  ) => Promise<void>;
}

export function historyPageView(kit: HistoryPageViewKit) {
  const {
    actions,
    allArchived,
    anchor,
    approvalIds,
    archive,
    busy,
    chosen,
    endSelection,
    groups,
    headingId,
    host,
    kind,
    labels,
    loading,
    mode,
    more,
    noun,
    now,
    onDelete,
    onMoveToProject,
    onNewChat,
    onOpenConversation,
    order,
    query,
    retrySearch,
    rowEntries,
    rowMenu,
    rowMenuAnchor,
    rows,
    searchError,
    searchQuery,
    searchSort,
    selected,
    selecting,
    setQuery,
    setRowMenu,
    setSearchSort,
    setSelected,
    setSelecting,
    setTab,
    settle,
    shared,
    shown,
    snippets,
    tab,
    tabsId,
    title,
    updateSelection,
  } = kit;
  const historyPageViewView = (
    <div className="collection-view history-view">
      <CollectionHeader
        title={title}
        tabs={
          selecting ? (
            // Select puts the count where the tabs were.
            <span className="history-count" aria-live="polite">
              {formatText("{count} selected", {
                count: selected.size.toLocaleString(currentLocale()),
              })}
            </span>
          ) : (
            <HistoryTabs
              id={tabsId}
              mode={mode}
              value={tab}
              onChange={(next) => {
                setTab(next);
                anchor.current = undefined;
              }}
            />
          )
        }
      >
        {selecting ? (
          <>
            <button
              type="button"
              className="collection-secondary"
              onClick={() =>
                setSelected(
                  selected.size === rows.length ? new Set() : new Set(order),
                )
              }
              disabled={!rows.length}
            >
              {selected.size === rows.length && rows.length
                ? "Deselect all"
                : "Select all"}
            </button>
            <div
              className="history-selection-actions"
              role="group"
              aria-label={t("Actions for the selection")}
            >
              {actions.pin.length > 0 && (
                <button
                  type="button"
                  className="collection-icon"
                  disabled={busy}
                  aria-label={t(actions.pinned ? "Unpin" : "Pin")}
                  onClick={() =>
                    void updateSelection(
                      actions.pin.map((row) => row.id),
                      { pinned: !actions.pinned },
                    )
                  }
                >
                  {actions.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                </button>
              )}
              {actions.read.length > 0 && (
                <button
                  type="button"
                  className="collection-icon"
                  disabled={busy}
                  aria-label={t(
                    actions.unread ? "Mark as read" : "Mark as unread",
                  )}
                  onClick={() =>
                    void updateSelection(
                      actions.read.map((row) => row.id),
                      { unread: !actions.unread },
                    )
                  }
                >
                  {actions.unread ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
              )}
              {onMoveToProject && actions.movable.length > 0 && (
                <button
                  type="button"
                  className="collection-icon"
                  disabled={!selected.size || busy}
                  aria-label={t(
                    actions.project ? "Change project" : "Add to project",
                  )}
                  onClick={() => onMoveToProject(actions.movable, settle)}
                >
                  <AppIcon name="Projects" />
                </button>
              )}
              <button
                type="button"
                className="collection-icon"
                disabled={!selected.size || busy}
                aria-label={t(allArchived ? "Unarchive" : "Archive")}
                onClick={() => void archive()}
              >
                <Archive size={16} />
              </button>
              <button
                type="button"
                className="collection-icon danger"
                disabled={!selected.size || busy}
                aria-label={t("Delete")}
                onClick={() =>
                  onDelete(
                    chosen.map((c) => c.id),
                    settle,
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
            {/* A ghost X after the actions, not a main button. */}
            <button
              type="button"
              className="collection-icon"
              aria-label={t("Exit selection")}
              onClick={endSelection}
            >
              <X size={20} />
            </button>
          </>
        ) : (
          <>
            {query === null ? (
              <button
                type="button"
                className="collection-icon"
                aria-label={labels.searchLabel}
                onClick={() => setQuery("")}
              >
                <PageSearchIcon />
              </button>
            ) : (
              <label className="collection-search">
                <SearchIcon size={16} />
                <input
                  autoFocus
                  aria-label={labels.searchLabel}
                  placeholder={labels.searchPlaceholder}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setQuery(null);
                    }
                  }}
                  onBlur={() => !query && setQuery(null)}
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setQuery(null)}
                  >
                    <X size={14} />
                  </button>
                )}
              </label>
            )}
            {/* Sort by: there while the search is open, greyed until something
               is typed; Type or Date. */}
            {query !== null && (
              <SearchSortButton
                disabled={!query.trim()}
                value={searchSort}
                onChange={setSearchSort}
              />
            )}
            {/* Beside the search field, not instead of it: the live branch only
               asks for rows. */}
            {rows.length > 0 && (
              <button
                type="button"
                className="collection-secondary"
                onClick={() => setSelecting(true)}
              >
                Select
              </button>
            )}
            <PrimaryAction onClick={onNewChat}>{labels.newLabel}</PrimaryAction>
          </>
        )}
      </CollectionHeader>
      {selecting && query && (
        <p className="history-filter-note" role="status">
          <span data-no-translate>
            {formatText(
              noun === "chat"
                ? "Showing only chats that match “{query}”."
                : "Showing only sessions that match “{query}”.",
              { query },
            )}
          </span>
          <button type="button" onClick={() => setQuery(null)}>
            Show all
          </button>
        </p>
      )}
      <div
        id={`${tabsId}-panel`}
        role={selecting ? undefined : "tabpanel"}
        aria-labelledby={selecting ? undefined : `${tabsId}-${tab}`}
      >
        {searchQuery && mode === "code" && (
          <p role="status" className="history-search-status">
            {t("Search covers the titles shown.")}
          </p>
        )}
        {searchError && (
          <p className="history-search-status">
            <span role="status">{t("Search isn’t working right now.")}</span>{" "}
            <button
              type="button"
              className="collection-secondary"
              onClick={retrySearch}
            >
              {t("Try again")}
            </button>
          </p>
        )}
        {loading || searchError ? null : rows.length ? (
          <div className={`history-list ${selecting ? "selecting" : ""}`}>
            {groups.map((group, index) => (
              <section
                key={group.key}
                aria-labelledby={
                  group.label ? `${headingId}-${index}` : undefined
                }
              >
                {group.label && (
                  <h2 id={`${headingId}-${index}`}>{group.label}</h2>
                )}
                <ul role="list">
                  {group.rows.map((c) => {
                    const checked = selected.has(c.id);
                    const snippet =
                      searchQuery && mode !== "code"
                        ? snippets.get(c.id)
                        : undefined;
                    return (
                      <li
                        key={c.id}
                        className={rowMenu?.id === c.id ? "menu-open" : ""}
                      >
                        <button
                          type="button"
                          role={selecting ? "checkbox" : undefined}
                          aria-checked={selecting ? checked : undefined}
                          className={`history-item ${checked ? "checked" : ""}`}
                          onClick={(event) => {
                            if (!selecting) return onOpenConversation(c);
                            setSelected(
                              rangeSelection(
                                order,
                                selected,
                                anchor.current,
                                c.id,
                                event.shiftKey,
                              ),
                            );
                            anchor.current = c.id;
                          }}
                        >
                          {selecting && (
                            <span
                              className={`cx-check ${checked ? "on" : ""}`}
                              aria-hidden="true"
                            >
                              {checked && <Check size={14} strokeWidth={2.2} />}
                            </span>
                          )}
                          <HistoryRowText
                            title={c.title}
                            snippet={snippet}
                            query={query ?? ""}
                            accessories={
                              c.archived &&
                              tab !== "archived" && (
                                <span className="history-tag">
                                  <Archive size={12} />
                                  {t("Archived")}
                                </span>
                              )
                            }
                          />
                          {tab !== "shared" && shared.has(c.id) && (
                            <span className="history-tag">Shared</span>
                          )}
                          {historyNeedsAttention(c, approvalIds.has(c.id)) && (
                            <span
                              className="history-attention"
                              role="img"
                              aria-label={t("Needs attention")}
                            />
                          )}
                          {c.mode === "code" && (
                            <HistoryRepositoryText conversation={c} />
                          )}
                          <time dateTime={new Date(c.updatedAt).toISOString()}>
                            {collectionTime(c.updatedAt, now)}
                          </time>
                        </button>
                        {!selecting && (
                          <button
                            type="button"
                            className="history-more"
                            aria-label={formatText(
                              "More options for {chatName}",
                              { chatName: c.title || t("Untitled") },
                            )}
                            aria-haspopup="menu"
                            aria-expanded={rowMenu?.id === c.id}
                            onClick={(event) => {
                              rowMenuAnchor.current = event.currentTarget;
                              setRowMenu(rowMenu?.id === c.id ? undefined : c);
                            }}
                          >
                            <EllipsisVertical size={16} strokeWidth={1.6} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {rows.length > shown && (
              <div
                ref={more}
                className="history-more-rows"
                aria-hidden="true"
              />
            )}
          </div>
        ) : (
          <p className="collection-empty-note">
            {query
              ? formatText("Nothing matches “{query}”", { query })
              : historyTabEmptyText(mode, tab, kind !== "both")}
          </p>
        )}
      </div>
      {rowMenu && (
        <PageMenu
          label={`${rowMenu.title} actions`}
          width={176}
          anchor={rowMenuAnchor}
          entries={rowEntries(rowMenu)}
          onClose={() => setRowMenu(undefined)}
        />
      )}
    </div>
  );
  return historyPageViewView;
}
