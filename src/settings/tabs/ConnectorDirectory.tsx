import { Suspense, useRef, useState } from "react";
import {
  ArrowRight,
  RefreshCw,
  SlidersHorizontal,
  Check,
  Plus,
} from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { formatText } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import { lazyPiece } from "../../ui/lazy-piece";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import {
  DirectoryReviewBadge,
  CommunityExplainer,
} from "../directory/DirectoryReview";
import { connectorServer } from "../../../shared/connectors-catalogue";
import { Menu, type MenuEntry, type MenuPosition } from "../../ui/Menu";
import { directoryGlyph } from "../directory/icons";
import {
  connectorTopics,
  connectors,
  defaultConnectorFilter,
  findConnectors,
  type CatalogueConnector,
  type ConnectorFilter,
} from "../../../shared/connectors-catalogue";
import "../../collections/customize/customize-directory.css";
import "../../collections/customize/customize.css";
import "../directory/connector-directory.css";

const ConnectorFeatured = lazyPiece(
  () => import("../directory/ConnectorFeatured"),
);

/** The filter narrows the list (its button shows it; Reset filters clears it). */
export const connectorFilterActive = (filter: ConnectorFilter) =>
  Boolean(filter.topic) || filter.type !== "all";

/**
 * The directory's filter menu: All categories, Topic › with each topic's count,
 * then Type (All, New, Verified, Community) with counts.
 */
export function ConnectorFilterButton({
  filter,
  onChange,
  entries: catalogue = connectors,
}: {
  filter: ConnectorFilter;
  onChange: (filter: ConnectorFilter) => void;
  entries?: CatalogueConnector[];
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  const count = (patch: Partial<ConnectorFilter>) =>
    String(
      findConnectors({ ...defaultConnectorFilter, ...patch }, catalogue).length,
    );
  const entries: MenuEntry[] = [
    {
      label: "All categories",
      checked: !filter.topic,
      onSelect: () => onChange({ ...filter, topic: undefined }),
    },
    { separator: true },
    {
      label: "Topic",
      submenu: [
        ...new Set([
          ...connectorTopics,
          ...catalogue.map((entry) => entry.topic).filter(Boolean),
        ]),
      ]
        .sort((left, right) => left.localeCompare(right))
        .map((topic) => ({
          label: topic,
          value: count({ topic }),
          checked: filter.topic === topic,
          onSelect: () => onChange({ ...filter, topic }),
        })),
    },
    { separator: true },
    { heading: "Type" },
    ...(
      [
        ["all", "All"],
        ["new", "New"],
        ["trending", "Trending"],
        ["verified", "Verified"],
        ["community", "Community"],
        ["inChatUi", "In-chat UI"],
        ["desktopExtension", "Desktop extensions"],
        ["custom", "Custom"],
      ] as const
    ).map(([type, label]) => ({
      label,
      value: type === "all" ? undefined : count({ type }),
      checked: filter.type === type,
      onSelect: () => onChange({ ...filter, type }),
    })),
  ];
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`directory-filter-button ${connectorFilterActive(filter) ? "filtered" : ""}`}
        aria-label="Filter connectors"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => {
          const rect = anchor.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: innerWidth - rect.right - 20, top: rect.bottom + 4 },
          );
        }}
      >
        <SlidersHorizontal size={16} strokeWidth={1.6} />
      </button>
      {menu && (
        <Menu
          label="Filter connectors"
          size="regular"
          width={236}
          position={menu}
          anchors={[anchor]}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

type ConnectorActions = {
  onLinear?: () => void;
  onOpen?: (entry: CatalogueConnector) => void;
  onConnect?: (entry: CatalogueConnector) => void;
  servers?: McpServerState[];
  busy?: string;
  canConnect?: (entry: CatalogueConnector) => boolean;
};

/** Directory actions. */
export function ConnectorCards({
  entries,
  onLinear,
  onOpen,
  onConnect,
  servers = [],
  busy,
  canConnect,
}: { entries: CatalogueConnector[] } & ConnectorActions) {
  return (
    <ul className="customize-cards customize-directory-cards connector-cards">
      {entries.map((entry) => {
        const Glyph = directoryGlyph(entry.icon);
        const server = connectorServer(entry, servers);
        const connected =
          server?.state === "ready" && server.authStatus !== "notLoggedIn";
        return (
          <li key={entry.id}>
            <button
              type="button"
              className="customize-card"
              onClick={() => onOpen?.(entry)}
            >
              <span className="customize-card-tile" aria-hidden="true">
                <Glyph size={20} strokeWidth={1.4} />
              </span>
              <span className="customize-card-text">
                <strong>
                  {entry.name}
                  <DirectoryReviewBadge
                    review={entry.type}
                    kind={
                      entry.desktopExtension ? "desktop_extension" : "connector"
                    }
                  />
                  {entry.desktopExtension && (
                    <em className="connector-badge">Desktop extension</em>
                  )}
                  {entry.isTrending ? (
                    <em className="connector-badge new">Trending</em>
                  ) : (
                    entry.isNew && <em className="connector-badge new">New</em>
                  )}
                </strong>
                <span className="customize-card-description">
                  {entry.description}
                </span>
                <small>{entry.byline}</small>
              </span>
            </button>
            {(server || entry.type !== "community") && (
              <span className="customize-card-add">
                {connected ? (
                  <WithTooltip
                    label={formatText("{name} is connected", {
                      name: entry.name,
                    })}
                  >
                    {(props) => (
                      <span {...props} tabIndex={0}>
                        <Check
                          size={18}
                          aria-label={formatText("{name} is connected", {
                            name: entry.name,
                          })}
                        />
                      </span>
                    )}
                  </WithTooltip>
                ) : (
                  <button
                    type="button"
                    aria-label={formatText(
                      server?.authStatus === "notLoggedIn"
                        ? "Re-authorize {name}"
                        : busy !== undefined &&
                            (busy === server?.name || busy === entry.id)
                          ? "Connecting {name}…"
                          : "Connect {name} to Claudex",
                      { name: entry.name },
                    )}
                    disabled={
                      busy !== undefined || canConnect?.(entry) === false
                    }
                    onClick={() =>
                      onConnect
                        ? onConnect(entry)
                        : onOpen
                          ? onOpen(entry)
                          : onLinear?.()
                    }
                  >
                    {busy && (busy === server?.name || busy === entry.id) ? (
                      <Spinner inheritColor size={18} className="spin" />
                    ) : server?.authStatus === "notLoggedIn" ? (
                      <RefreshCw size={18} strokeWidth={1.4} />
                    ) : (
                      <Plus size={18} strokeWidth={1.4} />
                    )}
                  </button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Discover's front: Top connectors with its count and Show all. */
export function ConnectorDiscover({
  filter,
  onLinear,
  onOpen,
  onShowAll,
  onReset,
  entries: catalogue = connectors,
  onBrowse,
  onConnect,
  servers,
  busy,
  canConnect,
  plugins,
}: {
  filter: ConnectorFilter;
  onLinear?: () => void;
  onOpen?: (entry: CatalogueConnector) => void;
  onShowAll: () => void;
  onReset: () => void;
  entries?: CatalogueConnector[];
  onBrowse?: (filter: ConnectorFilter) => void;
  plugins?: React.ReactNode;
} & ConnectorActions) {
  const entries = findConnectors(filter, catalogue);
  if (!entries.length) return <NothingMatches onReset={onReset} />;
  const filtering = connectorFilterActive(filter) || filter.query.trim();
  const actions = { onLinear, onOpen, onConnect, servers, busy, canConnect };
  if (filtering)
    return (
      <>
        <h2>{connectorFilterTitle(filter.type)}</h2>
        {filter.type === "community" && <CommunityExplainer />}
        <ConnectorCards entries={entries} {...actions} />
        <button type="button" className="directory-link" onClick={onReset}>
          Clear filters
        </button>
      </>
    );
  return (
    <>
      {catalogue.some((entry) => entry.featured) && (
        <Suspense fallback={null}>
          <ConnectorFeatured entries={catalogue} onOpen={onOpen} />
        </Suspense>
      )}
      {connectorShelves(catalogue).map((shelf) => (
        <section key={shelf.title} className="connector-directory-section">
          <div className="customize-directory-head connector-top-head">
            <h2>
              {shelf.title}{" "}
              <span className="settings-badge">{shelf.entries.length}</span>
            </h2>
            <button
              type="button"
              onClick={() =>
                onBrowse
                  ? onBrowse({ ...defaultConnectorFilter, type: shelf.type })
                  : onShowAll()
              }
            >
              Show all
              <ArrowRight size={14} />
            </button>
          </div>
          <ConnectorCards
            entries={shelf.entries.slice(0, shelf.type === "all" ? 12 : 6)}
            {...actions}
          />
        </section>
      ))}
      {plugins}
      <section className="connector-directory-section">
        <h2>Categories</h2>
        <ul className="customize-categories">
          {[...new Set(catalogue.map((entry) => entry.topic).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right))
            .map((topic) => {
              const Glyph = directoryGlyph(
                catalogue.find((entry) => entry.topic === topic)!.icon,
              );
              return (
                <li key={topic}>
                  <button
                    type="button"
                    onClick={() =>
                      onBrowse?.({ ...defaultConnectorFilter, topic })
                    }
                  >
                    <span
                      className="customize-category-tile"
                      aria-hidden="true"
                    >
                      <Glyph size={24} />
                    </span>
                    <span>{topic}</span>
                  </button>
                </li>
              );
            })}
        </ul>
      </section>
    </>
  );
}

export function connectorFilterTitle(type: ConnectorFilter["type"]) {
  return {
    all: "All connectors",
    new: "New connectors",
    trending: "Trending connectors",
    verified: "Verified connectors",
    community: "Community connectors",
    custom: "Custom connectors",
    inChatUi: "Connectors with in-chat UI",
    desktopExtension: "Desktop extensions",
  }[type];
}

export function connectorShelves(entries: CatalogueConnector[]) {
  return [
    {
      title: "Your custom connectors",
      type: "custom" as const,
      entries: entries.filter((entry) => entry.installed),
    },
    {
      title: "Top connectors",
      type: "all" as const,
      entries: entries.filter((entry) => !entry.installed),
    },
    {
      title: "Trending connectors",
      type: "trending" as const,
      entries: entries.filter((entry) => entry.isTrending),
    },
    {
      title: "New connectors",
      type: "new" as const,
      entries: entries.filter((entry) => entry.isNew && !entry.isTrending),
    },
  ].filter((shelf) => shelf.entries.length > 0);
}

/** No entries for the filters: the magnifier, the line and Reset. */
export function NothingMatches({
  onReset,
  message = "No connectors match your filters",
  hint = "Try a different search or clear your filters.",
}: {
  onReset?: () => void;
  message?: string;
  /** A line under the message (a search with no match suggests the Directory). */
  hint?: string;
}) {
  return (
    <div className="directory-nothing">
      <svg
        width="84"
        height="84"
        viewBox="0 0 84 84"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="24.5" cy="24" r="21.5" className="lens" />
        <path d="M41 44.5 44.5 47.5" />
        <path d="M40.5 48 49.5 40 80.5 73 71.5 81Z" strokeLinejoin="round" />
      </svg>
      <p>{message}</p>
      {hint && <p className="directory-nothing-hint">{hint}</p>}
      {onReset && (
        <button type="button" onClick={onReset}>
          Clear filters
        </button>
      )}
    </div>
  );
}
