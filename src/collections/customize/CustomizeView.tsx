import { Link } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { t, formatText } from "../../i18n";
import { Suspense } from "react";
import {
  UnifiedSearch,
  PluginAddConnector,
  ManageMarketplacesDialog,
  CreatePluginDialog,
} from "./CustomizePage";
import { Menu } from "../../ui/Menu";
import { PageMenu } from "../PageMenu";
import { PluginDetailDialog } from "../../plugins/PluginDetailDialog";
import { AddMarketplaceDialog } from "../../plugins/AddMarketplaceDialog";
import { CreateSkillDialog } from "./CreateSkillDialog";
import { SkillNameDialog } from "./NameCopyDialog";
import type { MenuEntry } from "../../ui/Menu";
import type {
  View,
  ConnectorStatus,
  ConnectorType,
  OpenMenu,
  Tab,
} from "./CustomizePage";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { PageMenuEntry } from "../PageMenu";
import type {
  CustomizeSkill,
  PluginEntry,
  PluginCatalog,
  PluginCopy,
} from "../../../shared/collections-api";
import type { CustomizePlace } from "../../web/customize-route";
import type { CustomizeSearchHit } from "../../../shared/customize-search";
import type { StarterSkill } from "./starter-skills";
import type { SkillOrigin, CustomizeOffers } from "./customize-list";
import type { SearchItem } from "./UnifiedSearch";
import type { ConnectorFilterAvailability } from "../../settings/directory/connector-categories";
import type { Settings } from "../../../shared/types";
import type { HostInfo } from "../../../shared/host";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { CustomizeSearchAdapter } from "./customize-search-adapter";
import { CustomizeNav } from "./CustomizeNav";
import { CustomizeDiscoverSections } from "./CustomizeDiscoverSections";

/** What customizeView needs from CustomizePage.tsx. */
export interface CustomizeViewKit {
  addBlocked:
    | "Custom connectors aren’t available for this account."
    | "MCP servers can be changed once Claudex reaches your service."
    | "Your administrator has turned off adding MCP servers."
    | undefined;
  addButton: React.RefObject<HTMLButtonElement | null>;
  addingMarketplace: boolean;
  canSearchCatalog: boolean;
  categoryFilterEntries: () => MenuEntry[];
  changeView: (next: View) => void;
  closeConnector: () => void;
  closeConnectorDirectory: () => void;
  closePlugin: () => void;
  column: React.RefObject<HTMLDivElement | null>;
  connectorCategory: string | undefined;
  connectorFilterLabel: string;
  connectorListing: boolean;
  connectorListingTitle: string;
  connectorRows: McpServerState[];
  connectorStatus: ConnectorStatus;
  connectorType: ConnectorType;
  copyConnectorCategory: () => void;
  creating: boolean;
  directoryEntries: ApprovedDirectoryEntry[] | undefined;
  directoryError: boolean;
  directoryLoading: boolean;
  filterAnchor: React.RefObject<HTMLSpanElement | null>;
  host: HostInfo;
  loadDirectory: () => Promise<void>;
  loadServers: () => Promise<void>;
  loadSkills: () => Promise<void>;
  marketplaceList: boolean;
  menu: OpenMenu | undefined;
  menuEntries: (current: OpenMenu) => PageMenuEntry[];
  menuWidth: 200 | 182 | 236 | 172 | 176;
  naming: { kind: "duplicate" | "rename"; skill: CustomizeSkill } | undefined;
  offers: CustomizeOffers;
  onError: (error: unknown) => void;
  onOpenSettings: (tab: string) => void;
  onRouteChange: ((place: CustomizePlace) => void) | undefined;
  open: (
    kind: "sort" | "filter" | "add" | "row",
    element: HTMLElement | null,
  ) => void | null;
  openConnector: (id: string) => void;
  openConnectorCategory: (
    category?: string | undefined,
    type?:
      | "all"
      | "trending"
      | "new"
      | "verified"
      | "community"
      | "inChatUi"
      | "desktopExtension",
  ) => void;
  openConnectorDirectory: (
    type?:
      | "all"
      | "trending"
      | "new"
      | "verified"
      | "community"
      | "inChatUi"
      | "desktopExtension",
  ) => void;
  openPlugin: (plugin: PluginEntry) => void;
  openSearchResult: (hit: CustomizeSearchHit) => void;
  openSkill: (skill: CustomizeSkill | StarterSkill) => void;
  origin: SkillOrigin;
  own: CustomizeSkill[];
  pluginAction: "upload" | "manage" | "create" | "connector" | undefined;
  pluginCategory: string | undefined;
  pluginMarketplace: string | undefined;
  plugins: {
    reload: () => Promise<void>;
    catalog?: PluginCatalog | undefined;
    loading: boolean;
    failure?: string | undefined;
    busy?: string | undefined;
    install: (id: string) => Promise<string[]>;
    uninstall: (id: string) => Promise<void>;
    addMarketplace: (source: string) => Promise<void>;
    addOfficial: () => Promise<void>;
    removeMarketplace: (name: string) => Promise<void>;
    upgradeMarketplaces: (name?: string | undefined) => Promise<void>;
    setAutoSync: (name: string, enabled: boolean) => Promise<void>;
    duplicate?:
      | ((
          id: string,
          copy: PluginCopy,
        ) => Promise<{ id: string; appsNeedingAuth: string[] }>)
      | undefined;
    rename?:
      | ((
          id: string,
          to: PluginCopy,
        ) => Promise<{ id: string; appsNeedingAuth: string[] }>)
      | undefined;
  };
  policy: ClientPolicy;
  query: string | null;
  route: CustomizePlace | undefined;
  rowAnchor: React.RefObject<HTMLElement | null>;
  searchAdapter: CustomizeSearchAdapter | undefined;
  searchInput: React.RefObject<HTMLInputElement | null>;
  searchItems: SearchItem[];
  searching: boolean;
  servers: McpServerState[] | undefined;
  serversError: boolean;
  serversLoading: boolean;
  setAddingMarketplace: React.Dispatch<React.SetStateAction<boolean>>;
  setConnectorFilterMetadata: React.Dispatch<
    React.SetStateAction<ConnectorFilterAvailability | undefined>
  >;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setNaming: React.Dispatch<
    React.SetStateAction<
      { kind: "duplicate" | "rename"; skill: CustomizeSkill } | undefined
    >
  >;
  setOrigin: React.Dispatch<React.SetStateAction<SkillOrigin>>;
  setPluginAction: React.Dispatch<
    React.SetStateAction<
      "upload" | "manage" | "create" | "connector" | undefined
    >
  >;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setSubmissionsPage: React.Dispatch<
    React.SetStateAction<"list" | "plugin" | "mcp" | undefined>
  >;
  setTab: React.Dispatch<React.SetStateAction<Tab>>;
  setView: React.Dispatch<React.SetStateAction<View>>;
  settings: Settings;
  settledSearch: string;
  shownConnectorDirectoryType:
    | "all"
    | "trending"
    | "new"
    | "verified"
    | "community"
    | "inChatUi"
    | "desktopExtension";
  shownPlugin: PluginEntry | undefined;
  skillDetail: React.JSX.Element | undefined;
  skillSortLabel: string;
  skills: CustomizeSkill[] | undefined;
  skillsError: boolean;
  skillsLoading: boolean;
  sortAnchor: React.RefObject<HTMLSpanElement | null>;
  switchTab: (next: Tab) => void;
  tab: Tab;
  tryPlugin:
    | ((
        id: string,
        current?: (() => boolean) | undefined,
      ) => void | Promise<void>)
    | undefined;
  unified: boolean;
  view: View;
  wide: boolean;
  yours: CustomizeSkill[];
}

export function customizeView(kit: CustomizeViewKit) {
  const {
    addBlocked,
    addButton,
    addingMarketplace,
    canSearchCatalog,
    categoryFilterEntries,
    changeView,
    closeConnector,
    closeConnectorDirectory,
    closePlugin,
    column,
    connectorCategory,
    connectorFilterLabel,
    connectorListing,
    connectorListingTitle,
    connectorRows,
    connectorStatus,
    connectorType,
    copyConnectorCategory,
    creating,
    directoryEntries,
    directoryError,
    directoryLoading,
    filterAnchor,
    host,
    loadDirectory,
    loadServers,
    loadSkills,
    marketplaceList,
    menu,
    menuEntries,
    menuWidth,
    naming,
    offers,
    onError,
    onOpenSettings,
    onRouteChange,
    open,
    openConnector,
    openConnectorCategory,
    openConnectorDirectory,
    openPlugin,
    openSearchResult,
    openSkill,
    origin,
    own,
    pluginAction,
    pluginCategory,
    pluginMarketplace,
    plugins,
    policy,
    query,
    route,
    rowAnchor,
    searchAdapter,
    searchInput,
    searchItems,
    searching,
    servers,
    serversError,
    serversLoading,
    setAddingMarketplace,
    setConnectorFilterMetadata,
    setCreating,
    setMenu,
    setNaming,
    setOrigin,
    setPluginAction,
    setQuery,
    setSubmissionsPage,
    setTab,
    setView,
    settings,
    settledSearch,
    shownConnectorDirectoryType,
    shownPlugin,
    skillDetail,
    skillSortLabel,
    skills,
    skillsError,
    skillsLoading,
    sortAnchor,
    switchTab,
    tab,
    tryPlugin,
    unified,
    view,
    wide,
    yours,
  } = kit;
  const pageView = (
    <div
      className={`customize-view${connectorListing ? " customize-connector-category-view" : ""}`}
    >
      {connectorListing && (
        <div
          className="customize-connector-pane-header"
          style={{ height: 48, flex: "none" }}
        >
          <div className="customize-connector-pane-actions">
            <button
              type="button"
              className="connector-published-copy"
              onClick={copyConnectorCategory}
            >
              <Link size={16} />
              Copy link
            </button>
          </div>
        </div>
      )}
      <div className="customize-head">
        <div className="customize-column" ref={column}>
          {connectorListing ? (
            <div className="customize-connector-category-header">
              <a
                href="/customize/connectors"
                className="customize-listing-back"
                onClick={(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  closeConnectorDirectory();
                }}
              >
                <AppIcon name="CaretLeft" size={16} />
                Connectors
              </a>
              <div className="customize-connector-category-title">
                <h1 className="customize-title">{t(connectorListingTitle)}</h1>
              </div>
            </div>
          ) : (
            <h1 className="customize-title">Customize</h1>
          )}
          <CustomizeNav
            addBlocked={addBlocked}
            addButton={addButton}
            changeView={changeView}
            connectorFilterLabel={connectorFilterLabel}
            connectorListing={connectorListing}
            connectorStatus={connectorStatus}
            connectorType={connectorType}
            filterAnchor={filterAnchor}
            marketplaceList={marketplaceList}
            menu={menu}
            offers={offers}
            open={open}
            origin={origin}
            pluginCategory={pluginCategory}
            pluginMarketplace={pluginMarketplace}
            query={query}
            searchInput={searchInput}
            searching={searching}
            setQuery={setQuery}
            skillSortLabel={skillSortLabel}
            sortAnchor={sortAnchor}
            switchTab={switchTab}
            tab={tab}
            view={view}
            wide={wide}
          />
        </div>
      </div>
      <div className="customize-scroll">
        <div
          className={`customize-column${tab === "skills" && view === "yours" ? " customize-yours" : ""}`}
        >
          {unified ? (
            <Suspense fallback={null}>
              <UnifiedSearch
                query={query ?? ""}
                settledQuery={settledSearch}
                page={tab}
                items={searchItems}
                adapter={searchAdapter}
                onOpenResult={openSearchResult}
                sources={[
                  {
                    loading: skillsLoading,
                    failed: skillsError,
                    retry: () => void loadSkills(),
                  },
                  {
                    loading: serversLoading,
                    failed: serversError,
                    retry: () => void loadServers(),
                  },
                  {
                    loading:
                      plugins.loading || (!plugins.catalog && !plugins.failure),
                    failed:
                      !!plugins.failure || !!plugins.catalog?.loadErrors.length,
                    retry: () => void plugins.reload(),
                  },
                  ...(canSearchCatalog
                    ? [
                        {
                          loading:
                            directoryLoading ||
                            (!directoryEntries && !directoryError),
                          failed: directoryError,
                          retry: () => void loadDirectory(),
                        },
                      ]
                    : []),
                ]}
              />
            </Suspense>
          ) : (
            <CustomizeDiscoverSections
              changeView={changeView}
              closeConnector={closeConnector}
              connectorCategory={connectorCategory}
              connectorListing={connectorListing}
              connectorRows={connectorRows}
              connectorStatus={connectorStatus}
              directoryEntries={directoryEntries}
              host={host}
              loadServers={loadServers}
              loadSkills={loadSkills}
              menu={menu}
              offers={offers}
              onError={onError}
              onOpenSettings={onOpenSettings}
              openConnector={openConnector}
              openConnectorCategory={openConnectorCategory}
              openConnectorDirectory={openConnectorDirectory}
              openPlugin={openPlugin}
              openSkill={openSkill}
              origin={origin}
              own={own}
              pluginCategory={pluginCategory}
              pluginMarketplace={pluginMarketplace}
              plugins={plugins}
              policy={policy}
              query={query}
              route={route}
              rowAnchor={rowAnchor}
              searching={searching}
              servers={servers}
              serversError={serversError}
              setAddingMarketplace={setAddingMarketplace}
              setConnectorFilterMetadata={setConnectorFilterMetadata}
              setMenu={setMenu}
              setOrigin={setOrigin}
              setQuery={setQuery}
              setSubmissionsPage={setSubmissionsPage}
              settings={settings}
              shownConnectorDirectoryType={shownConnectorDirectoryType}
              skills={skills}
              skillsError={skillsError}
              tab={tab}
              tryPlugin={tryPlugin}
              view={view}
              yours={yours}
            />
          )}
        </div>
      </div>
      {menu && connectorListing && menu.kind === "filter" ? (
        <Menu
          label="Filter"
          entries={categoryFilterEntries()}
          size="regular"
          width={235}
          position={{ top: menu.rect.bottom + 7, left: menu.rect.left }}
          className="customize-connector-category-menu"
          submenuClassName="customize-connector-category-menu"
          anchors={[filterAnchor]}
          onClose={() => setMenu(undefined)}
        />
      ) : (
        menu && (
          <PageMenu
            label={
              menu.kind === "row"
                ? formatText("More actions for {name}", {
                    name: menu.skill!.name,
                  })
                : menu.kind === "add"
                  ? "Add"
                  : menu.kind === "sort"
                    ? skillSortLabel
                    : "Filter"
            }
            width={menuWidth}
            anchor={
              menu.kind === "add"
                ? addButton
                : menu.kind === "filter"
                  ? filterAnchor
                  : menu.kind === "sort"
                    ? sortAnchor
                    : rowAnchor
            }
            entries={menuEntries(menu)}
            onClose={() => setMenu(undefined)}
          />
        )
      )}
      {shownPlugin && (
        <PluginDetailDialog
          onUsePlugin={tryPlugin}
          key={shownPlugin.id}
          plugin={shownPlugin}
          plugins={plugins}
          onClose={closePlugin}
          onError={onError}
        />
      )}
      {addingMarketplace && (
        <AddMarketplaceDialog
          plugins={plugins}
          onClose={() => setAddingMarketplace(false)}
          onAdded={() => changeView("discover")}
        />
      )}
      <Suspense fallback={null}>
        {pluginAction === "connector" && (
          <PluginAddConnector
            onClose={() => setPluginAction(undefined)}
            onAdded={() => {
              setPluginAction(undefined);
              void plugins.reload();
            }}
            onError={onError}
          />
        )}
        {pluginAction === "manage" && (
          <ManageMarketplacesDialog
            plugins={plugins}
            onClose={() => setPluginAction(undefined)}
            onAdd={() => {
              setPluginAction(undefined);
              setAddingMarketplace(true);
            }}
            onError={onError}
          />
        )}
        {pluginAction === "create" && (
          <CreatePluginDialog
            onClose={() => setPluginAction(undefined)}
            onCreated={() => {
              void plugins.reload();
              changeView("yours");
            }}
          />
        )}
      </Suspense>
      {creating && (
        <CreateSkillDialog
          onClose={() => setCreating(false)}
          onCreate={async (skill) => {
            await window.desktop.saveSkill(skill);
            await loadSkills();
            setCreating(false);
            setTab("skills");
            setView("yours");
            if (route) onRouteChange?.({ section: "skills", view: "yours" });
          }}
        />
      )}
      {naming && (
        <SkillNameDialog
          kind={naming.kind}
          skill={naming.skill}
          onDone={() => void loadSkills()}
          onClose={() => setNaming(undefined)}
        />
      )}
      {skillDetail}
    </div>
  );
  return pageView;
}
