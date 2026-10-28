import { IconButton } from "../../ui/Controls";
import { PageSearchIcon, PageFilterIcon, InfoIcon } from "../../ui/icons";
import { X, ArrowUpDown, ChevronDown } from "../../ui/glyphs";
import { routinesOffMessage } from "../../../shared/routines";
import { ScheduleConfirmCard } from "./ScheduleConfirmCard";
import { SecurityFindings } from "./RoutinesPage";
import { TemplateGrid } from "./RoutineCard";
import { webRoutineTemplates, routineTemplates } from "./routine-templates";
import { CardsSkeleton } from "../../ui/Skeleton";
import { AppIcon } from "../../ui/app-icon";
import { StopwatchArt, WaveRule } from "./RoutineArt";
import { formatText } from "../../i18n";
import { noMatchText, defaultRoutineFilter } from "./routine-list";
import { Menu } from "../../ui/Menu";
import { Suspense } from "react";
import type { RoutineDraft } from "./routine-draft";
import type { Routine, RoutineSourceState } from "../../../shared/routines";
import type { OpenMenu, Tab } from "./RoutinesPage";
import type { MenuEntry } from "../../ui/Menu";
import type { RoutineFilter } from "./routine-list";
import type { Settings, DesktopAPI } from "../../../shared/types";
import type { RoutineTemplate } from "./routine-templates";

/** What routinesView needs from RoutinesPage.tsx. */
export interface RoutinesViewKit {
  blocked: string | undefined;
  completedCount: number;
  confirming: RoutineDraft | undefined;
  editor: React.JSX.Element | undefined;
  filterAnchor: React.RefObject<HTMLSpanElement | null>;
  filtered: boolean;
  filtering: boolean;
  findings: Routine | undefined;
  isWeb: boolean;
  keys: {
    onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void;
    onResultsKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
  };
  loadError: boolean;
  loading: boolean;
  menu: OpenMenu | undefined;
  menuEntries: (current: OpenMenu) => MenuEntry[];
  menuWidth: 180 | 168 | 176;
  newButton: React.RefObject<HTMLButtonElement | null>;
  off: boolean;
  onError: (error: unknown) => void;
  onOpenConversation: (id: string) => void;
  open: (
    kind: "sort" | "filter" | "new",
    element: HTMLElement | null,
  ) => void | null;
  query: string | null;
  queryState: {
    refresh: () => Promise<void>;
    tasks: Routine[];
    sources: RoutineSourceState[];
    loading: boolean;
    retrying: boolean;
    owner: unknown;
    bridge: DesktopAPI;
  };
  refresh: () => Promise<void>;
  renderCard: (routine: Routine) => React.JSX.Element;
  results: React.RefObject<HTMLUListElement | null>;
  retry: () => undefined;
  routines: Routine[];
  rowAnchor: React.RefObject<HTMLElement | null>;
  rows: Routine[];
  runNow: (routine: Routine) => Promise<void>;
  searchInput: React.RefObject<HTMLInputElement | null>;
  sections: { main: Routine[]; completed: Routine[] };
  selectTab: (next: Tab) => void;
  setConfirming: React.Dispatch<React.SetStateAction<RoutineDraft | undefined>>;
  setDraft: React.Dispatch<React.SetStateAction<RoutineDraft | undefined>>;
  setFilter: React.Dispatch<React.SetStateAction<RoutineFilter>>;
  setFindings: React.Dispatch<React.SetStateAction<Routine | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  settings: Settings;
  showCompleted: boolean;
  sortAnchor: React.RefObject<HTMLSpanElement | null>;
  sourceFailures: RoutineSourceState[];
  startNew: (
    template?: RoutineTemplate | undefined,
    location?: "local" | "remote" | undefined,
  ) => void;
  tab: Tab;
  web: boolean;
}

export function routinesView(kit: RoutinesViewKit) {
  const {
    blocked,
    completedCount,
    confirming,
    editor,
    filterAnchor,
    filtered,
    filtering,
    findings,
    isWeb,
    keys,
    loadError,
    loading,
    menu,
    menuEntries,
    menuWidth,
    newButton,
    off,
    onError,
    onOpenConversation,
    open,
    query,
    queryState,
    refresh,
    renderCard,
    results,
    retry,
    routines,
    rowAnchor,
    rows,
    runNow,
    searchInput,
    sections,
    selectTab,
    setConfirming,
    setDraft,
    setFilter,
    setFindings,
    setMenu,
    setQuery,
    settings,
    showCompleted,
    sortAnchor,
    sourceFailures,
    startNew,
    tab,
    web,
  } = kit;
  const pageView = (
    <div className="routines-view">
      <div className="routines-inner">
        {!isWeb && settings.computerAccess === false && (
          <p role="status">
            Computer access is off, so tasks that require a computer won’t run.
          </p>
        )}
        {isWeb ? (
          <div className="routines-head">
            <div className="routines-title-row">
              <h1 className="routines-title">Scheduled tasks</h1>
            </div>
            <div className="routines-bar">
              <div
                className="routines-tabs"
                role="tablist"
                aria-label="Scheduled tasks view"
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "yours"
                      : event.key === "End"
                        ? "templates"
                        : tab === "yours"
                          ? "templates"
                          : "yours";
                  selectTab(next);
                  event.currentTarget
                    .querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
                    ?.focus();
                }}
              >
                {(["yours", "templates"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    data-tab={value}
                    aria-selected={tab === value}
                    tabIndex={tab === value ? 0 : -1}
                    className={tab === value ? "selected" : ""}
                    onClick={() => selectTab(value)}
                  >
                    {value === "yours" ? "Yours" : "Templates"}
                  </button>
                ))}
              </div>
              <div className="routines-tools">
                {tab === "yours" && (
                  <>
                    {query === null ? (
                      <IconButton
                        label="Search scheduled tasks"
                        className="routines-icon"
                        onClick={() => setQuery("")}
                      >
                        <PageSearchIcon size={20} />
                      </IconButton>
                    ) : (
                      <label className="routines-search">
                        <PageSearchIcon size={16} />
                        <input
                          ref={searchInput}
                          aria-label="Search scheduled tasks"
                          placeholder="Search scheduled tasks"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          onKeyDown={keys.onInputKeyDown}
                        />
                        <button
                          type="button"
                          aria-label="Close search"
                          onClick={() => setQuery(null)}
                        >
                          <X size={15} strokeWidth={1.6} />
                        </button>
                      </label>
                    )}
                    <span ref={filterAnchor} className="routines-anchor">
                      <IconButton
                        label="Filter scheduled tasks"
                        className={`routines-icon ${filtering ? "filtered" : ""}`}
                        menu
                        expanded={menu?.kind === "filter"}
                        onClick={() => open("filter", filterAnchor.current)}
                      >
                        <PageFilterIcon size={20} />
                      </IconButton>
                    </span>
                    <span ref={sortAnchor} className="routines-anchor">
                      <IconButton
                        label="Sort scheduled tasks"
                        className="routines-icon"
                        menu
                        expanded={menu?.kind === "sort"}
                        onClick={() => open("sort", sortAnchor.current)}
                      >
                        <ArrowUpDown size={20} strokeWidth={1.6} />
                      </IconButton>
                    </span>
                  </>
                )}
                <button
                  ref={newButton}
                  type="button"
                  className="routines-new u-press"
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === "new"}
                  disabled={Boolean(blocked)}
                  title={blocked}
                  onClick={(event) => open("new", event.currentTarget)}
                >
                  New task
                  <ChevronDown size={16} strokeWidth={1.6} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <h1 className="routines-title">Scheduled tasks</h1>
            <div className="routines-bar">
              <div
                className="routines-tabs"
                role="tablist"
                aria-label="Scheduled tasks"
              >
                {(["yours", "templates"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    className={tab === value ? "selected" : ""}
                    onClick={() => selectTab(value)}
                  >
                    {value === "yours" ? "Yours" : "Templates"}
                  </button>
                ))}
              </div>
              <div className="routines-tools">
                {tab === "yours" &&
                  (query === null ? (
                    <IconButton
                      label="Search scheduled tasks"
                      className="routines-icon"
                      onClick={() => setQuery("")}
                    >
                      <PageSearchIcon size={16} />
                    </IconButton>
                  ) : (
                    <label className="routines-search">
                      <PageSearchIcon size={14} />
                      <input
                        ref={searchInput}
                        aria-label="Search scheduled tasks"
                        placeholder="Search scheduled tasks…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={keys.onInputKeyDown}
                      />
                      <button
                        type="button"
                        aria-label="Close search"
                        onClick={() => setQuery(null)}
                      >
                        <X size={15} strokeWidth={1.6} />
                      </button>
                    </label>
                  ))}
                {tab === "yours" && (
                  <>
                    <span ref={filterAnchor} className="routines-anchor">
                      <IconButton
                        label="Filter scheduled tasks"
                        className={`routines-icon ${filtering ? "filtered" : ""}`}
                        menu
                        expanded={menu?.kind === "filter"}
                        onClick={() => open("filter", filterAnchor.current)}
                      >
                        <PageFilterIcon size={16} />
                      </IconButton>
                    </span>
                    <span ref={sortAnchor} className="routines-anchor">
                      <IconButton
                        label="Sort tasks"
                        className="routines-icon"
                        menu
                        expanded={menu?.kind === "sort"}
                        onClick={() => open("sort", sortAnchor.current)}
                      >
                        <ArrowUpDown size={14} strokeWidth={1.6} />
                      </IconButton>
                    </span>
                  </>
                )}
                <button
                  ref={newButton}
                  type="button"
                  className="routines-new u-press"
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === "new"}
                  disabled={Boolean(blocked)}
                  title={blocked}
                  onClick={(event) => open("new", event.currentTarget)}
                >
                  New task
                  <ChevronDown size={12} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </>
        )}
        {blocked && (
          <p className="routines-notice" role="status">
            <InfoIcon size={12} />
            {off && !web ? routinesOffMessage : blocked}
          </p>
        )}
        {tab === "yours" &&
          routines.length > 0 &&
          sourceFailures.length > 0 && (
            <div className="routines-notice" role="alert">
              {sourceFailures.map((source) => (
                <span key={source.source}>
                  {source.source === "remote"
                    ? "Couldn’t load cloud scheduled tasks."
                    : "Couldn’t load local scheduled tasks."}
                  {source.message && (
                    <span data-no-translate> {source.message}</span>
                  )}
                </span>
              ))}
              <button
                type="button"
                className="secondary"
                disabled={queryState.retrying}
                onClick={retry}
              >
                {queryState.retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
        {tab === "yours" &&
          !loadError &&
          !web &&
          !isWeb &&
          routines.length > 0 && (
            <p className="routines-notice">
              <InfoIcon size={12} />
              Local scheduled tasks only run while your computer is awake and
              online.
            </p>
          )}
        {confirming && (
          <ScheduleConfirmCard
            draft={confirming}
            settings={settings}
            count={routines.length}
            onCancel={() => setConfirming(undefined)}
            onEdit={() => {
              setDraft(confirming);
              setConfirming(undefined);
            }}
            onCreated={() => {
              setConfirming(undefined);
              selectTab("yours");
              void refresh().catch(onError);
            }}
          />
        )}
        {tab === "templates" ? (
          <TemplateGrid
            disabled={Boolean(blocked)}
            onUse={startNew}
            templates={isWeb ? webRoutineTemplates : routineTemplates}
          />
        ) : loading ? (
          <CardsSkeleton />
        ) : loadError ? (
          // A centred alert with a secondary Retry.
          <div className="routines-load-error" role="alert">
            <AppIcon name="Warning" size={20} aria-hidden="true" />
            {sourceFailures.map((source) => (
              <span key={source.source}>
                {source.source === "remote"
                  ? "Couldn’t load cloud scheduled tasks."
                  : "Couldn’t load local scheduled tasks."}
              </span>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={retry}
              disabled={queryState.retrying}
            >
              {queryState.retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : !routines.length ? (
          <>
            <div className="routines-empty">
              <StopwatchArt />
              <p>No scheduled tasks yet.</p>
              {isWeb && (
                <button
                  type="button"
                  className="routines-manual"
                  disabled={Boolean(blocked)}
                  onClick={() => startNew()}
                >
                  Set up manually
                </button>
              )}
            </div>
            <WaveRule />
            <TemplateGrid
              disabled={Boolean(blocked)}
              onUse={startNew}
              templates={isWeb ? webRoutineTemplates : routineTemplates}
            />
          </>
        ) : rows.length ? (
          <>
            {sections.main.length > 0 && (
              <ul
                ref={results}
                className="routine-grid"
                aria-label="Scheduled tasks"
                onKeyDown={keys.onResultsKeyDown}
              >
                {sections.main.map(renderCard)}
              </ul>
            )}
            {completedCount > 0 && !showCompleted && (
              <p className="routines-completed-hidden" role="status">
                {formatText(
                  completedCount === 1
                    ? "{count} completed scheduled task hidden"
                    : "{count} completed scheduled tasks hidden",
                  { count: completedCount },
                )}
              </p>
            )}
            {completedCount > 0 && showCompleted && (
              <section
                className="routines-completed"
                aria-labelledby="routines-completed-title"
              >
                <h2 id="routines-completed-title" className="routines-section">
                  Completed
                </h2>
                <ul
                  ref={sections.main.length ? undefined : results}
                  className="routine-grid"
                  aria-label="Completed"
                  onKeyDown={
                    sections.main.length ? undefined : keys.onResultsKeyDown
                  }
                >
                  {sections.completed.map(renderCard)}
                </ul>
              </section>
            )}
          </>
        ) : (
          <div className="routines-none-block">
            <p className="routines-none" role="status">
              {filtered
                ? noMatchText(Boolean(query?.trim()), filtering, isWeb)
                : "No scheduled tasks yet."}
            </p>
            {filtered && (
              <button
                type="button"
                className="routines-clear"
                onClick={() => {
                  setQuery(null);
                  setFilter(defaultRoutineFilter);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
      {menu && (
        <Menu
          label={
            menu.kind === "row"
              ? formatText("More options for {title}", {
                  title: menu.routine.name,
                })
              : menu.kind === "new"
                ? "New task"
                : menu.kind === "sort"
                  ? "Sort scheduled tasks"
                  : "Filter scheduled tasks"
          }
          width={menuWidth}
          position={{
            top: menu.rect.bottom + 6,
            left: Math.max(8, menu.rect.right - menuWidth),
          }}
          anchors={[
            menu.kind === "new"
              ? newButton
              : menu.kind === "filter"
                ? filterAnchor
                : menu.kind === "sort"
                  ? sortAnchor
                  : rowAnchor,
          ]}
          entries={menuEntries(menu)}
          onClose={() => setMenu(undefined)}
        />
      )}
      {editor}
      {findings && (
        <Suspense fallback={null}>
          <SecurityFindings
            routine={findings}
            runBlocked={off ? routinesOffMessage : undefined}
            onRun={(routine) => void runNow(routine)}
            onOpenConversation={onOpenConversation}
            onClose={() => setFindings(undefined)}
          />
        </Suspense>
      )}
    </div>
  );
  return pageView;
}
