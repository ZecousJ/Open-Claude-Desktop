import { t, formatText } from "../i18n";
import { Suspense } from "react";
import { ImportSharedArtifactDialog } from "./ArtifactsPage";
import { PageSearchIcon, PageFilterIcon } from "../ui/icons";
import { LayoutGrid, List, Search, X } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import { galleryTypes } from "./gallery";
import { TypeMenu, ArtifactRow } from "./ArtifactRow";
import { isEditEndKey } from "../ui/ime";
import { MakeSomethingNew, makeTemplates } from "./MakeSomethingNew";
import { Menu } from "../ui/Menu";
import { ArtifactsSkeleton, ArtifactGridCard } from "./ArtifactGridCard";
import { artifactIdentity } from "./artifact-metadata";
import { EmptyState } from "../ui/EmptyState";
import { ArtifactPanel } from "./FileViewer";
import type { Artifact } from "../ui/components";
import type { GalleryType, ArtifactOwner, ArtifactGroup } from "./gallery";
import type { Row } from "./ArtifactsPage";
import type { HostInfo } from "../../shared/host";
import type { SharingStatus } from "../../shared/sharing-api";

/** What artifactsPageView needs from ArtifactsPage.tsx. */
export interface ArtifactsPageViewKit {
  actions: {
    onOpen: (artifact: Artifact) => void;
    hrefForArtifact: ((artifact: Artifact) => string) | undefined;
    onPin: (artifact: Artifact) => Promise<void>;
    onDuplicate: (artifact: Artifact) => Promise<void>;
    onDelete: (artifact: Artifact) => void;
    onDownload: (a: Artifact) => undefined;
    onCopyLink: (url: string) => undefined;
    onError: (error: unknown) => void;
  };
  artifact: Artifact | undefined;
  artifacts: Artifact[];
  authorName: string;
  clearSearch: () => void;
  counts: Map<GalleryType, number>;
  designMode: boolean;
  emptyVariant: "artifacts" | "first";
  host: HostInfo;
  importing: boolean;
  notesLoaded: boolean;
  now: number;
  onChat: ((artifact: Artifact) => void) | undefined;
  onClose: () => void;
  onComment: (text: string) => Promise<void>;
  onCreate: (
    prompt?: string | undefined,
    kind?: "design" | "docs" | "slides" | "dashboard" | undefined,
  ) => void;
  onDelete: (artifact: Artifact) => void;
  onDuplicate: (artifact: Artifact) => Promise<void>;
  onError: (error: unknown) => void;
  onImportArtifact: ((token: string) => Promise<void>) | undefined;
  onNotify: (message: string) => void;
  onOpenDesign: (() => void) | undefined;
  onPin: (artifact: Artifact) => Promise<void>;
  onResize: (width: number) => void;
  onShareRequestConsumed: () => void;
  onSwitch: ((artifact: Artifact) => void) | undefined;
  onTryFix: ((error: string) => Promise<void>) | undefined;
  openDesign: () => void;
  owner: ArtifactOwner;
  panelId: string;
  query: string;
  rows: Row[];
  search: React.RefObject<HTMLInputElement | null>;
  searching: boolean;
  sections: { id: string; label: string; rows: Row[] }[];
  selectedOwner: ArtifactOwner;
  setImporting: React.Dispatch<React.SetStateAction<boolean>>;
  setOwner: (value: ArtifactOwner) => void;
  setQuery: (value: string) => void;
  setSearching: React.Dispatch<React.SetStateAction<boolean>>;
  setStoredView: (value: "list" | "grid") => void;
  setType: React.Dispatch<React.SetStateAction<GalleryType | undefined>>;
  setTypeMenu: React.Dispatch<React.SetStateAction<boolean>>;
  groupBy: ArtifactGroup;
  setGroupBy: (value: ArtifactGroup) => void;
  toolMenu: { kind: "group" | "new"; rect: DOMRect } | undefined;
  setToolMenu: (
    value: { kind: "group" | "new"; rect: DOMRect } | undefined,
  ) => void;
  sharedSearchCapped: boolean;
  sharing: SharingStatus | null;
  shown: Row[];
  siblings: (() => Artifact[]) | undefined;
  tabs: { id: ArtifactOwner; label: string }[];
  type: GalleryType | undefined;
  typeMenu: boolean;
  versionsOf: ((artifact: Artifact) => Artifact[]) | undefined;
  view: "list" | "grid";
  width: number;
}

/**
 * Group by's choices; the button names the choice briefly ("Group by: None").
 */
const groupLabels: Record<ArtifactGroup, string> = {
  none: "None (Last edited)",
  date: "Date edited",
  owner: "Owner",
  type: "Type",
};
const groupShort: Record<ArtifactGroup, string> = {
  ...groupLabels,
  none: "None",
};

export function artifactsPageView(kit: ArtifactsPageViewKit) {
  const {
    actions,
    artifact,
    artifacts,
    authorName,
    clearSearch,
    counts,
    designMode,
    emptyVariant,
    host,
    importing,
    notesLoaded,
    now,
    onChat,
    onClose,
    onComment,
    onCreate,
    onDelete,
    onDuplicate,
    onError,
    onImportArtifact,
    onNotify,
    onOpenDesign,
    onPin,
    onResize,
    onShareRequestConsumed,
    onSwitch,
    onTryFix,
    openDesign,
    owner,
    panelId,
    query,
    rows,
    search,
    searching,
    sections,
    selectedOwner,
    setImporting,
    setOwner,
    setQuery,
    setSearching,
    setStoredView,
    setType,
    setTypeMenu,
    groupBy,
    setGroupBy,
    toolMenu,
    setToolMenu,
    sharedSearchCapped,
    sharing,
    shown,
    siblings,
    tabs,
    type,
    typeMenu,
    versionsOf,
    view,
    width,
  } = kit;
  const artifactsPageViewView = (
    <div className="chat-layout">
      <div className="artifacts-page" data-host={host.kind}>
        {/* The title's row holds the page's action at its end, as the
            Projects page's New project. */}
        <header className="artifacts-header">
          <h1>{designMode ? t("Design") : t("Artifacts")}</h1>
          {host.kind !== "web" &&
            !designMode &&
            sharing?.artifacts &&
            onImportArtifact && (
              <button
                type="button"
                className="secondary"
                onClick={() => setImporting(true)}
              >
                {t("Import from link")}
              </button>
            )}
        </header>
        {importing && onImportArtifact && (
          <Suspense fallback={null}>
            <ImportSharedArtifactDialog
              onClose={() => setImporting(false)}
              onImport={onImportArtifact}
              onError={onError}
            />
          </Suspense>
        )}
        {artifacts.length ? (
          <>
            <div className="artifacts-toolbar">
              <div
                className="artifacts-owner-tabs"
                role="tablist"
                aria-label={t("Artifacts")}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button",
                    ),
                  );
                  const current = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : (current +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            buttons.length) %
                          buttons.length;
                  buttons[next]?.focus();
                  buttons[next]?.click();
                }}
              >
                {tabs.map(({ id, label }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={selectedOwner === id}
                    aria-controls={panelId}
                    tabIndex={selectedOwner === id ? 0 : -1}
                    onClick={() => setOwner(id)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <div className="artifacts-tools">
                {!searching && (
                  <button
                    className="artifacts-tool"
                    aria-label={t("Search your artifacts")}
                    onClick={() => setSearching(true)}
                  >
                    <PageSearchIcon />
                  </button>
                )}
                {/* Group by: a ghost button with its choice and a caret, 12px
                   after the search. */}
                <button
                  type="button"
                  className="artifacts-group"
                  aria-label={formatText("Group by: {group}", {
                    group: t(groupShort[groupBy]),
                  })}
                  aria-haspopup="menu"
                  aria-expanded={toolMenu?.kind === "group"}
                  onClick={(event) =>
                    setToolMenu(
                      toolMenu?.kind === "group"
                        ? undefined
                        : {
                            kind: "group",
                            rect: event.currentTarget.getBoundingClientRect(),
                          },
                    )
                  }
                >
                  {formatText("Group by: {group}", {
                    group: t(groupShort[groupBy]),
                  })}
                  <AppIcon name="CaretDown" size={16} />
                </button>
                <button
                  className="artifacts-tool"
                  aria-label={t(view === "list" ? "Grid view" : "List view")}
                  onClick={() =>
                    setStoredView(view === "list" ? "grid" : "list")
                  }
                >
                  {view === "list" ? (
                    <LayoutGrid size={20} strokeWidth={1.5} />
                  ) : (
                    <List size={20} strokeWidth={1.5} />
                  )}
                </button>
                <div className="artifacts-type-anchor">
                  <button
                    className={`artifacts-tool ${type ? "active" : ""}`}
                    aria-label={formatText("Filter by type: {type}", {
                      type: t(
                        type
                          ? galleryTypes.find((value) => value.type === type)!
                              .label
                          : "All types",
                      ),
                    })}
                    aria-haspopup="menu"
                    aria-expanded={typeMenu}
                    onClick={() => setTypeMenu(!typeMenu)}
                  >
                    <PageFilterIcon />
                  </button>
                  {typeMenu && (
                    <TypeMenu
                      type={type}
                      counts={counts}
                      total={rows.length}
                      onChoose={(value) => {
                        setType(value);
                        setTypeMenu(false);
                      }}
                      onClose={() => setTypeMenu(false)}
                    />
                  )}
                </div>
                {/* The live toolbar's fourth button opens a separate vendor service;
                    without a Design destination of its own it is not drawn. */}
                {onOpenDesign && (
                  <button
                    type="button"
                    className="artifacts-tool artifacts-design-tool"
                    aria-label={t("Design")}
                    onClick={openDesign}
                  >
                    {/* The live toolbar: DotsHorizontal. */}
                    <AppIcon name="DotsHorizontal" size={20} />
                  </button>
                )}
                <button
                  type="button"
                  className="artifacts-tool artifacts-new"
                  aria-label={t("New")}
                  aria-haspopup="menu"
                  aria-expanded={toolMenu?.kind === "new"}
                  onClick={(event) =>
                    setToolMenu(
                      toolMenu?.kind === "new"
                        ? undefined
                        : {
                            kind: "new",
                            rect: event.currentTarget.getBoundingClientRect(),
                          },
                    )
                  }
                >
                  <AppIcon name="Add" size={20} />
                </button>
                {toolMenu && (
                  <Menu
                    label={t(toolMenu.kind === "group" ? "Group by" : "New")}
                    width={toolMenu.kind === "group" ? 192 : 172}
                    position={{
                      top: toolMenu.rect.bottom + 6,
                      right: innerWidth - toolMenu.rect.right,
                    }}
                    entries={
                      toolMenu.kind === "group"
                        ? (Object.keys(groupLabels) as ArtifactGroup[]).map(
                            (value) => ({
                              label: groupLabels[value],
                              checked: groupBy === value,
                              checkedRole: "radio" as const,
                              onSelect: () => setGroupBy(value),
                            }),
                          )
                        : [
                            {
                              label: "Chat",
                              icon: <AppIcon name="Chat" size={20} />,
                              onSelect: () => onCreate(""),
                            },
                            { separator: true as const },
                            ...makeTemplates.map(
                              ({ name, badge, prompt, kind, icon }) => ({
                                label: name,
                                icon: <AppIcon name={icon} size={20} />,
                                ...(badge === "Beta" ? { badge } : {}),
                                onSelect: () => onCreate(prompt, kind),
                              }),
                            ),
                          ]
                    }
                    onClose={() => setToolMenu(undefined)}
                  />
                )}
              </div>
            </div>
            {searching && (
              <div className="artifacts-search" role="search">
                <Search size={14} strokeWidth={1.75} />
                <input
                  ref={search}
                  className="artifacts-search-field"
                  aria-label={t("Search your artifacts")}
                  placeholder="Search artifacts..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (isEditEndKey(event, "Escape")) {
                      clearSearch();
                      setSearching(false);
                    }
                  }}
                />
                <button
                  aria-label="Close search"
                  onClick={() => {
                    clearSearch();
                    setSearching(false);
                  }}
                >
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {sharedSearchCapped && (
              <p className="artifacts-search-note">
                {t(
                  "Only the 60 most recent artifacts shared with you are searchable here.",
                )}
              </p>
            )}
            {!searching && notesLoaded && (
              <>
                <MakeSomethingNew
                  onCreate={(prompt, kind) => onCreate(prompt, kind)}
                />
              </>
            )}
            <div
              className="artifacts-tab-panel"
              id={panelId}
              role="tabpanel"
              aria-label={t(
                tabs.find(({ id }) => id === selectedOwner)?.label ?? "All",
              )}
            >
              {!notesLoaded ? (
                <ArtifactsSkeleton view={view} />
              ) : !shown.length ? (
                <div className="artifacts-no-results" role="status">
                  <p>
                    {query.trim()
                      ? formatText("No artifacts matching “{search}”", {
                          search: query.trim(),
                        })
                      : owner === "shared"
                        ? "No shared artifacts yet"
                        : "No artifacts of this type"}
                  </p>
                  {!query.trim() && owner === "shared" && (
                    <p>
                      When someone shares an artifact with you, it appears here.
                    </p>
                  )}
                </div>
              ) : view === "grid" ? (
                // Grouped, each group is its heading over its own grid.
                sections.map((section) => (
                  <section
                    key={section.id}
                    className="artifacts-grid-section"
                    aria-label={section.label ? t(section.label) : undefined}
                  >
                    {section.label && <h2>{t(section.label)}</h2>}
                    <ul
                      className="artifacts-grid"
                      role="list"
                      aria-label={t(section.label || "Artifacts")}
                    >
                      {section.rows.map((row) => (
                        <ArtifactGridCard
                          key={
                            row.artifact.libraryId ??
                            artifactIdentity(row.artifact)
                          }
                          artifact={row.artifact}
                          name={row.name}
                          type={row.type}
                          time={row.time}
                          viewed={row.viewed}
                          now={now}
                          {...actions}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              ) : (
                sections.map((section) => (
                  <section
                    key={section.id}
                    className="artifacts-section"
                    aria-label={section.label}
                  >
                    {section.label && <h2>{t(section.label)}</h2>}
                    <div role="list">
                      {section.rows.map((row) => (
                        <ArtifactRow
                          key={
                            row.artifact.libraryId ??
                            artifactIdentity(row.artifact)
                          }
                          row={row}
                          now={now}
                          {...actions}
                        />
                      ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          </>
        ) : (
          <EmptyState
            className="artifacts-empty"
            pictogram={
              emptyVariant === "artifacts" ? "ObjectShapes" : undefined
            }
            headline={t(
              emptyVariant === "artifacts"
                ? "What will you build with artifacts?"
                : "Create your first artifact",
            )}
            description={t(
              emptyVariant === "artifacts"
                ? "If you can dream it, you can build it. Take apps, games, templates, and tools from thought to reality."
                : "Artifacts you build with Claudex appear here.",
            )}
            ctaLabel={t("New artifact")}
            onCtaClick={() => onCreate()}
          />
        )}
      </div>
      {artifact && (
        <ArtifactPanel
          artifact={artifact}
          onComment={onComment}
          onTryFix={onTryFix}
          authorName={authorName}
          onShareRequestConsumed={onShareRequestConsumed}
          onDuplicate={onDuplicate}
          onPin={onPin}
          onDelete={onDelete}
          width={width}
          onResize={onResize}
          onClose={onClose}
          onError={onError}
          onNotify={onNotify}
          siblings={siblings}
          onSwitch={onSwitch}
          versionsOf={versionsOf}
          fullPage={artifact.surface === "artifact"}
          onChat={onChat ? () => onChat(artifact) : undefined}
        />
      )}
    </div>
  );
  return artifactsPageViewView;
}
