import { AppIcon } from "../../ui/app-icon";
import { ChevronDown, X, Plus } from "../../ui/glyphs";
import { IconButton } from "../../ui/Controls";
import { PageSearchIcon } from "../../ui/icons";
import type {
  View,
  ConnectorStatus,
  ConnectorType,
  OpenMenu,
  Tab,
} from "./CustomizePage";
import type { CustomizeOffers, SkillOrigin } from "./customize-list";

/** What CustomizeNav needs from CustomizeView.tsx. */
export interface CustomizeNavProps {
  addBlocked:
    | "Custom connectors aren’t available for this account."
    | "MCP servers can be changed once Claudex reaches your service."
    | "Your administrator has turned off adding MCP servers."
    | undefined;
  addButton: React.RefObject<HTMLButtonElement | null>;
  changeView: (next: View) => void;
  connectorFilterLabel: string;
  connectorListing: boolean;
  connectorStatus: ConnectorStatus;
  connectorType: ConnectorType;
  filterAnchor: React.RefObject<HTMLSpanElement | null>;
  marketplaceList: boolean;
  menu: OpenMenu | undefined;
  offers: CustomizeOffers;
  open: (
    kind: "sort" | "filter" | "add" | "row",
    element: HTMLElement | null,
  ) => void | null;
  origin: SkillOrigin;
  pluginCategory: string | undefined;
  pluginMarketplace: string | undefined;
  query: string | null;
  searchInput: React.RefObject<HTMLInputElement | null>;
  searching: boolean;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  skillSortLabel: string;
  sortAnchor: React.RefObject<HTMLSpanElement | null>;
  switchTab: (next: Tab) => void;
  tab: Tab;
  view: View;
  wide: boolean;
}

export function CustomizeNav({
  addBlocked,
  addButton,
  changeView,
  connectorFilterLabel,
  connectorListing,
  connectorStatus,
  connectorType,
  filterAnchor,
  marketplaceList,
  menu,
  offers,
  open,
  origin,
  pluginCategory,
  pluginMarketplace,
  query,
  searchInput,
  searching,
  setQuery,
  skillSortLabel,
  sortAnchor,
  switchTab,
  tab,
  view,
  wide,
}: CustomizeNavProps) {
  return (
    <div className="customize-bar">
      <div className="customize-nav">
        {connectorListing && (
          <span ref={filterAnchor} className="customize-anchor">
            <button
              type="button"
              className="settings-button customize-connector-category-filter"
              aria-label={connectorFilterLabel}
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "filter"}
              onClick={() => open("filter", filterAnchor.current)}
            >
              <AppIcon name="Filter" size={20} />
              {connectorFilterLabel}
              <ChevronDown size={16} />
            </button>
          </span>
        )}
        {!connectorListing && (
          <div
            className="customize-tabs"
            role="tablist"
            aria-label="Customize sections"
          >
            {(["skills", "connectors", "plugins"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? "selected" : ""}
                onClick={() => switchTab(value)}
              >
                {value === "skills"
                  ? "Skills"
                  : value === "connectors"
                    ? "Connectors"
                    : "Plugins"}
              </button>
            ))}
          </div>
        )}
        {!connectorListing && (
          <div className="customize-view-switch">
            <span className="customize-divider" aria-hidden="true" />
            <div
              className="customize-views"
              role="radiogroup"
              aria-label={
                tab === "skills"
                  ? "Skills"
                  : tab === "connectors"
                    ? "Connectors"
                    : "Plugins"
              }
            >
              {(["yours", "discover"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={view === value}
                  tabIndex={view === value ? 0 : -1}
                  className={view === value ? "selected" : ""}
                  onKeyDown={(event) => {
                    if (
                      ![
                        "ArrowLeft",
                        "ArrowRight",
                        "ArrowUp",
                        "ArrowDown",
                        "Home",
                        "End",
                      ].includes(event.key)
                    )
                      return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? "yours"
                        : event.key === "End"
                          ? "discover"
                          : view === "yours"
                            ? "discover"
                            : "yours";
                    changeView(next);
                    const buttons =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        "button",
                      );
                    buttons?.[next === "yours" ? 0 : 1]?.focus();
                  }}
                  onClick={() => {
                    changeView(value);
                  }}
                >
                  {value === "yours" ? "Yours" : "Discover"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className={`customize-tools${wide ? "" : " compact"}`}>
        {!connectorListing &&
          (query === null && !wide ? (
            <IconButton
              label="Search"
              className="customize-icon"
              onClick={() => setQuery("")}
            >
              <PageSearchIcon size={16} />
            </IconButton>
          ) : (
            <label className={`customize-search ${wide ? "wide" : ""}`}>
              <PageSearchIcon size={16} />
              <input
                ref={searchInput}
                aria-label="Search"
                placeholder="Search"
                maxLength={200}
                value={query ?? ""}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery(null);
                }}
              />
              {(!wide || searching) && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery(null)}
                >
                  <X size={16} strokeWidth={1.6} />
                </button>
              )}
            </label>
          ))}
        {!connectorListing &&
          (tab === "skills" || tab === "connectors" || view === "discover") && (
            <span ref={filterAnchor} className="customize-anchor">
              <IconButton
                label="Filter"
                className={`customize-icon ${(marketplaceList ? Boolean(pluginCategory || pluginMarketplace) : tab === "skills" ? origin !== "all" : connectorType !== "all" || connectorStatus !== "all") ? "filtered" : ""}`}
                menu
                tooltip={false}
                expanded={menu?.kind === "filter"}
                onClick={() => open("filter", filterAnchor.current)}
              >
                <AppIcon name="Filter" size={20} />
              </IconButton>
            </span>
          )}
        {tab !== "connectors" && (tab === "skills" || view === "discover") && (
          <span ref={sortAnchor} className="customize-anchor">
            <IconButton
              label={skillSortLabel}
              className="customize-icon"
              menu
              tooltip={false}
              expanded={menu?.kind === "sort"}
              onClick={() => open("sort", sortAnchor.current)}
            >
              <AppIcon name="Sort" size={20} />
            </IconButton>
          </span>
        )}
        {((tab === "connectors" && view === "discover") ||
          tab !== "connectors" ||
          offers.addConnectors) && (
          <button
            ref={addButton}
            type="button"
            className="customize-add u-press"
            aria-label={
              tab === "skills"
                ? "Add skill"
                : tab === "plugins"
                  ? "Add plugin"
                  : "Add connector"
            }
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "add"}
            disabled={Boolean(addBlocked)}
            title={addBlocked}
            onClick={(event) => open("add", event.currentTarget)}
          >
            <Plus size={20} strokeWidth={2} />
            Add
            <ChevronDown size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>
    </div>
  );
}
