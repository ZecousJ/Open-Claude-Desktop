import { t, formatText } from "../../i18n";
import type { PaletteFilterOption, PaletteFilterKey } from "./search-filters";
import {
  X,
  MoreHorizontal,
  CornerDownLeft,
  ArrowLeft,
  ArrowRight,
} from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { Skeleton, SkeletonGroup } from "../../ui/Skeleton";
import { AppIcon } from "../../ui/app-icon";
import {
  searchFilters,
  relativeBucket,
  paletteResultMessage,
  type composeTargets,
} from "./search-model";
import {
  searchConversationState,
  searchScheduleLabel,
  searchRoutineRunLabel,
} from "./row-metadata";
import { RowIcon, Marked } from "./SearchPalette";
import { keyName } from "../../ui/Tooltip";
import { PageMenu } from "../PageMenu";
import type {
  SearchRow,
  SearchFilter,
  SearchSources,
  SearchSection,
} from "./search-model";
import type { SearchEntrypoint } from "./palette-events";
import type { Attachment, Conversation } from "../../../shared/types";
import type { PageMenuEntry } from "../PageMenu";
import type { ZoneDropState } from "../../composer/drop-zones";
import { SearchCompose } from "./SearchCompose";
import { SearchPaletteHead } from "./SearchPaletteHead";

/** Widths of the placeholder titles, in turn. */
const skeletonWidths = [224, 176, 256, 200, 160, 240, 192];

/**
 * The results while they load: 13 title rows, under a heading block, with no
 * words typed, 9 rows with a snippet line and a time block for a search.
 */
export function ResultsSkeleton({ searching }: { searching: boolean }) {
  return (
    <SkeletonGroup className="search-skeleton" label={t("Loading")}>
      {!searching && (
        <div className="search-skeleton-heading">
          <Skeleton width={88} height={10} />
        </div>
      )}
      {Array.from({ length: searching ? 9 : 13 }, (_, at) => {
        const width = skeletonWidths[at % skeletonWidths.length];
        return (
          <div
            key={at}
            className={`search-skeleton-row${searching ? " snippet" : ""}`}
          >
            <Skeleton width={20} height={20} />
            {searching ? (
              <>
                <div className="search-skeleton-text">
                  <Skeleton width={width} height={14} />
                  <Skeleton width={width + 120} height={10} />
                </div>
                <Skeleton width={56} height={10} />
              </>
            ) : (
              <Skeleton width={width} height={14} />
            )}
          </div>
        );
      })}
    </SkeletonGroup>
  );
}

/** What searchPaletteView needs from SearchPalette.tsx. */
export interface SearchPaletteViewKit {
  activate: (row: SearchRow | undefined) => void;
  activeIndex: number;
  attach: () => undefined;
  chooseFilter: (option: PaletteFilterOption) => void;
  compose: React.RefObject<HTMLTextAreaElement | null>;
  composeBox: React.RefObject<HTMLDivElement | null>;
  composeKeys: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  deeper: {
    hits:
      | {
          conversationId: string;
          title: string;
          mode: "chat" | "cowork" | "code";
          archived: boolean;
          updatedAt: number;
          projectId?: string | undefined;
          turnId?: string | undefined;
          snippet?: string | undefined;
        }[]
      | undefined;
    titlesOnly: boolean;
    pending: boolean;
  };
  dropState: ZoneDropState;
  entrypoint: SearchEntrypoint;
  files: Attachment[];
  filter: SearchFilter;
  filterLabelId: string;
  filterOptions: PaletteFilterOption[];
  filters: Partial<Record<PaletteFilterKey, { value: string; label: string }>>;
  input: React.RefObject<HTMLInputElement | null>;
  list: React.RefObject<HTMLDivElement | null>;
  menuAnchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onEntrypointChange: ((entrypoint: SearchEntrypoint) => void) | undefined;
  onQueryChange: (query: string) => void;
  openRowMenu: (index: number) => void;
  overlay: {
    "data-nested": string | undefined;
    "data-nested-open": string | undefined;
    ref: React.RefObject<HTMLDivElement | null>;
  };
  pendingAction: string | undefined;
  picker: { key?: PaletteFilterKey | undefined; query: string } | undefined;
  placeholder:
    | "Search"
    | "Search sessions and projects"
    | "Search chats and projects"
    | "Search actions"
    | "Search or start a session"
    | "Search or start a chat";
  platform: string;
  query: string;
  rowEntries: (c: Conversation) => PageMenuEntry[];
  rowMenu: Conversation | undefined;
  rows: SearchRow[];
  searchKeys: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  sections: SearchSection[];
  send: () => void;
  setActive: (index: number) => void;
  setFiles: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setFilter: React.Dispatch<React.SetStateAction<SearchFilter>>;
  setFilters: React.Dispatch<
    React.SetStateAction<
      Partial<Record<PaletteFilterKey, { value: string; label: string }>>
    >
  >;
  setRowMenu: React.Dispatch<React.SetStateAction<Conversation | undefined>>;
  setTarget: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setView: React.Dispatch<React.SetStateAction<"search" | "compose">>;
  sources: Omit<SearchSources, "routines">;
  target: number;
  targets: ReturnType<typeof composeTargets>;
  text: string;
  view: "search" | "compose";
}

export function searchPaletteView(kit: SearchPaletteViewKit) {
  const {
    activate,
    activeIndex,
    attach,
    chooseFilter,
    compose,
    composeBox,
    composeKeys,
    deeper,
    dropState,
    entrypoint,
    files,
    filter,
    filterLabelId,
    filterOptions,
    filters,
    input,
    list,
    menuAnchor,
    onClose,
    onEntrypointChange,
    onQueryChange,
    openRowMenu,
    overlay,
    pendingAction,
    picker,
    placeholder,
    platform,
    query,
    rowEntries,
    rowMenu,
    rows,
    searchKeys,
    sections,
    send,
    setActive,
    setFiles,
    setFilter,
    setFilters,
    setRowMenu,
    setTarget,
    setText,
    setView,
    sources,
    target,
    targets,
    text,
    view,
  } = kit;
  let index = -1;
  // Rows carry their time except in the plain default list (no words, no
  // filters): the live bundle's timesHidden.
  const timesHidden =
    entrypoint === "default" &&
    !query.trim() &&
    filter === "all" &&
    !Object.keys(filters).length;
  const searchPaletteViewView = (
    <div
      {...overlay}
      className="search-palette-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {view === "compose" && (
        <div className="search-palette-modes" role="tablist" aria-label="Mode">
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => setView("search")}
          >
            Search
            <kbd>Tab</kbd>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={true}
            className="selected"
            onClick={() => setView("compose")}
          >
            Compose
          </button>
        </div>
      )}
      {view === "search" ? (
        <div
          className="search-palette"
          role="dialog"
          aria-modal="true"
          aria-label="Search"
        >
          <h2 className="sr-only">Search</h2>
          <SearchPaletteHead
            activeIndex={activeIndex}
            deeper={deeper}
            entrypoint={entrypoint}
            filterLabelId={filterLabelId}
            filterOptions={filterOptions}
            filters={filters}
            input={input}
            onClose={onClose}
            onEntrypointChange={onEntrypointChange}
            onQueryChange={onQueryChange}
            picker={picker}
            placeholder={placeholder}
            query={query}
            rows={rows}
            searchKeys={searchKeys}
            setActive={setActive}
            setFilters={setFilters}
          />
          {entrypoint !== "actions" && (
            <div
              className="search-palette-filters"
              role="group"
              aria-label={t("Filters")}
            >
              <div
                role="tablist"
                aria-label={t("Type")}
                className="search-palette-type-tabs"
              >
                {searchFilters.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={filter === value}
                    className={filter === value ? "selected" : ""}
                    onClick={() => {
                      setFilter(value);
                      input.current?.focus();
                    }}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              {filter !== "all" && (
                <button
                  type="button"
                  aria-label={t("Clear filter")}
                  onClick={() => setFilter("all")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div
            ref={list}
            id="search-palette-results"
            className="search-palette-results"
            role="listbox"
            aria-label={
              entrypoint === "actions"
                ? "Actions"
                : query.trim()
                  ? "Command palette options"
                  : "Search results"
            }
          >
            {!picker && !rows.length && deeper.pending && (
              <ResultsSkeleton searching={Boolean(query.trim())} />
            )}
            {deeper.titlesOnly && (
              <div className="search-palette-notice" role="status">
                {t("Search covers the titles shown.")}
              </div>
            )}
            {picker &&
              filterOptions.map((option, at) => (
                <div
                  key={`${option.key}:${option.value}`}
                  id={`search-filter-${at}`}
                  data-index={at}
                  role="option"
                  aria-selected={at === activeIndex}
                  className={`search-row ${at === activeIndex ? "active" : ""}`}
                  onMouseMove={() => setActive(at)}
                  onClick={() => chooseFilter(option)}
                >
                  {!picker.key && <span>{t("Filter by")}</span>}
                  <span
                    data-no-translate={
                      picker.key === "project" ||
                      picker.key === "repo" ||
                      undefined
                    }
                  >
                    {picker.key === "project" || picker.key === "repo"
                      ? option.label
                      : t(option.label)}
                  </span>
                </div>
              ))}
            {!picker &&
              sections.map((section) => (
                <div
                  key={section.title}
                  role="group"
                  aria-label={section.title}
                >
                  {section.title && (
                    <h3>
                      {section.title === "Actions" &&
                      entrypoint === "default" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setFilter("all");
                            setActive(0);
                            onEntrypointChange?.("actions");
                            input.current?.focus();
                          }}
                        >
                          {/* Plain text, no caret. */}
                          {t(section.title)}
                        </button>
                      ) : (
                        t(section.title)
                      )}
                    </h3>
                  )}
                  {section.rows.map((row) => {
                    index += 1;
                    const at = index;
                    const current = at === activeIndex;
                    const state =
                      row.kind === "conversation"
                        ? searchConversationState(
                            row.conversation,
                            sources.approvals,
                          )
                        : undefined;
                    const schedule =
                      row.kind === "routine"
                        ? searchScheduleLabel(row.routine)
                        : undefined;
                    const runCount =
                      row.kind === "routine"
                        ? searchRoutineRunLabel(row.routine)
                        : undefined;
                    return (
                      <div
                        key={row.key}
                        id={`search-row-${at}`}
                        data-index={at}
                        role="option"
                        aria-selected={current}
                        aria-disabled={pendingAction ? true : undefined}
                        aria-busy={pendingAction === row.key || undefined}
                        className={`search-row ${current ? "active" : ""}`}
                        onMouseMove={() => activeIndex !== at && setActive(at)}
                        onClick={() => activate(row)}
                      >
                        <span
                          className={`search-source-wrap${state ? " has-status" : ""}`}
                        >
                          <RowIcon row={row} />
                          {state && (
                            <span
                              className={`search-source-state ${state.kind}`}
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        <span
                          className={`search-row-title${schedule ? " has-metadata" : ""}`}
                          data-no-translate={row.kind !== "action" || undefined}
                        >
                          <span className="search-row-name">
                            {row.kind === "conversation" && row.terms ? (
                              <Marked text={row.title} terms={row.terms} />
                            ) : (
                              row.title
                            )}
                          </span>
                          {schedule && (
                            <span
                              className="search-row-schedule"
                              title={schedule}
                            >
                              <span aria-hidden="true">· </span>
                              {schedule}
                            </span>
                          )}
                          {state && (
                            <span className="sr-only"> {state.label}</span>
                          )}
                          {row.kind === "routine" && (
                            <span className="sr-only"> {t("Scheduled")}</span>
                          )}
                          {row.kind === "conversation" &&
                            row.terms &&
                            row.snippet && (
                              <span className="search-row-snippet">
                                “<Marked text={row.snippet} terms={row.terms} />
                                ”
                              </span>
                            )}
                        </span>
                        {runCount && (
                          <span className="search-row-run-count">
                            {runCount}
                          </span>
                        )}
                        {!current &&
                          !timesHidden &&
                          row.kind === "conversation" &&
                          !row.conversation.archived &&
                          relativeBucket(row.conversation.updatedAt) && (
                            <span className="search-row-time">
                              {relativeBucket(row.conversation.updatedAt)}
                            </span>
                          )}
                        {row.kind === "conversation" &&
                          row.conversation.archived && (
                            <span className="search-row-tag">
                              <AppIcon name="Archive" size={12} />
                              {t("Archived")}
                            </span>
                          )}
                        {current && row.kind === "conversation" && (
                          <button
                            type="button"
                            className="search-row-more"
                            aria-label={t("Actions")}
                            aria-haspopup="menu"
                            aria-expanded={rowMenu?.id === row.conversation.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              openRowMenu(at);
                            }}
                          >
                            <MoreHorizontal size={16} strokeWidth={1.6} />
                          </button>
                        )}
                        {pendingAction === row.key ? (
                          <Spinner size={16} aria-label={t("Loading")} />
                        ) : (
                          current && (
                            <CornerDownLeft
                              className="search-row-enter"
                              size={16}
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            {!(picker ? filterOptions.length : rows.length) &&
              !deeper.pending && (
                <div className="search-palette-empty">
                  <p aria-hidden="true">
                    {t(
                      deeper.titlesOnly
                        ? "Something went wrong"
                        : "No results found",
                    )}
                  </p>
                  {filter !== "all" && (
                    <button type="button" onClick={() => setFilter("all")}>
                      {t("Clear filters")}
                    </button>
                  )}
                </div>
              )}
          </div>
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {!deeper.pending &&
              (deeper.titlesOnly &&
              !(picker ? filterOptions.length : rows.length)
                ? t("Something went wrong")
                : formatText(
                    paletteResultMessage(
                      picker ? filterOptions.length : rows.length,
                    ),
                    {
                      count: picker ? filterOptions.length : rows.length,
                    },
                  ))}
          </div>
          <footer className="search-palette-foot">
            <span>
              Close <kbd>Esc</kbd>
            </span>
            {!query && !picker && (
              <span className="search-type-hint">
                {t("Change type")}
                <kbd className="search-icon-key">
                  <ArrowLeft size={12} aria-hidden="true" />
                  <span className="sr-only">Left</span>
                </kbd>
                <kbd className="search-icon-key">
                  <ArrowRight size={12} aria-hidden="true" />
                  <span className="sr-only">Right</span>
                </kbd>
              </span>
            )}
            <button
              className="search-filter-hint"
              type="button"
              onClick={() => onQueryChange("/")}
            >
              Filters <kbd>/</kbd>
            </button>
            {!picker && rows[activeIndex]?.kind === "conversation" && (
              <span>
                Actions{" "}
                <kbd className="search-icon-key">
                  {keyName(platform, "alt")}
                </kbd>
                <kbd className="search-icon-key">
                  <CornerDownLeft size={12} aria-hidden="true" />
                  <span className="sr-only">Enter</span>
                </kbd>
              </span>
            )}
            <button
              className="search-compose-hint"
              type="button"
              aria-keyshortcuts="Tab"
              onClick={() => setView("compose")}
            >
              Compose <kbd>Tab</kbd>
            </button>
          </footer>
        </div>
      ) : (
        <SearchCompose
          attach={attach}
          compose={compose}
          composeBox={composeBox}
          composeKeys={composeKeys}
          dropState={dropState}
          files={files}
          platform={platform}
          send={send}
          setFiles={setFiles}
          setTarget={setTarget}
          setText={setText}
          target={target}
          targets={targets}
          text={text}
        />
      )}
      {rowMenu && (
        <PageMenu
          label={`${rowMenu.title} actions`}
          width={176}
          anchor={menuAnchor}
          entries={rowEntries(rowMenu)}
          onClose={() => {
            setRowMenu(undefined);
            input.current?.focus();
          }}
        />
      )}
    </div>
  );
  return searchPaletteViewView;
}
