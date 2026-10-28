import { Suspense } from "react";
import { ServiceDirectory, CustomizeConnectors } from "./CustomizePage";
import { PluginsBody } from "../../plugins/PluginsBody";
import { notAvailable } from "../../settings/unavailable";
import { Folder } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { useOpenLink } from "../../ui/ExternalLinks";
import { helpUrl } from "../../../shared/help-links";
import { Connectors } from "./CustomizeRows";
import { CustomizeYoursSkills } from "./CustomizeYoursSkills";
import type { View, ConnectorStatus, OpenMenu, Tab } from "./CustomizePage";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { HostInfo } from "../../../shared/host";
import type { CustomizeOffers, SkillOrigin } from "./customize-list";
import type {
  PluginEntry,
  CustomizeSkill,
  PluginCatalog,
  PluginCopy,
} from "../../../shared/collections-api";
import type { StarterSkill } from "./starter-skills";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { CustomizePlace } from "../../web/customize-route";
import type { ConnectorFilterAvailability } from "../../settings/directory/connector-categories";
import type { Settings } from "../../../shared/types";

/** What CustomizeDiscoverSections needs from CustomizeView.tsx. */
export interface CustomizePart1Props {
  changeView: (next: View) => void;
  closeConnector: () => void;
  connectorCategory: string | undefined;
  connectorListing: boolean;
  connectorRows: McpServerState[];
  connectorStatus: ConnectorStatus;
  directoryEntries: ApprovedDirectoryEntry[] | undefined;
  host: HostInfo;
  loadServers: () => Promise<void>;
  loadSkills: () => Promise<void>;
  menu: OpenMenu | undefined;
  offers: CustomizeOffers;
  onError: (error: unknown) => void;
  onOpenSettings: (tab: string) => void;
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
      | "desktopExtension"
      | undefined,
  ) => void;
  openConnectorDirectory: (
    type?:
      | "all"
      | "trending"
      | "new"
      | "verified"
      | "community"
      | "inChatUi"
      | "desktopExtension"
      | undefined,
  ) => void;
  openPlugin: (plugin: PluginEntry) => void;
  openSkill: (skill: CustomizeSkill | StarterSkill) => void;
  origin: SkillOrigin;
  own: CustomizeSkill[];
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
  searching: boolean;
  servers: McpServerState[] | undefined;
  serversError: boolean;
  setAddingMarketplace: React.Dispatch<React.SetStateAction<boolean>>;
  setConnectorFilterMetadata: React.Dispatch<
    React.SetStateAction<ConnectorFilterAvailability | undefined>
  >;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setOrigin: React.Dispatch<React.SetStateAction<SkillOrigin>>;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setSubmissionsPage: React.Dispatch<
    React.SetStateAction<"list" | "plugin" | "mcp" | undefined>
  >;
  settings: Settings;
  shownConnectorDirectoryType:
    | "all"
    | "trending"
    | "new"
    | "verified"
    | "community"
    | "inChatUi"
    | "desktopExtension";
  skills: CustomizeSkill[] | undefined;
  skillsError: boolean;
  tab: Tab;
  tryPlugin:
    | ((
        id: string,
        current?: (() => boolean) | undefined,
      ) => void | Promise<void>)
    | undefined;
  view: View;
  yours: CustomizeSkill[];
}

export function CustomizeDiscoverSections({
  changeView,
  closeConnector,
  connectorCategory,
  connectorListing,
  connectorRows,
  connectorStatus,
  directoryEntries,
  host,
  loadServers,
  loadSkills,
  menu,
  offers,
  onError,
  onOpenSettings,
  openConnector,
  openConnectorCategory,
  openConnectorDirectory,
  openPlugin,
  openSkill,
  origin,
  own,
  pluginCategory,
  pluginMarketplace,
  plugins,
  policy,
  query,
  route,
  rowAnchor,
  searching,
  servers,
  serversError,
  setAddingMarketplace,
  setConnectorFilterMetadata,
  setMenu,
  setOrigin,
  setQuery,
  setSubmissionsPage,
  settings,
  shownConnectorDirectoryType,
  skills,
  skillsError,
  tab,
  tryPlugin,
  view,
  yours,
}: CustomizePart1Props) {
  const openLink = useOpenLink();
  // "Build for the Claudex Directory" under Yours on Plugins and Connectors.
  const buildForDirectory = (
    <section className="customize-build">
      <div>
        <strong>Build for the Claudex Directory</strong>
        <p>List your connector or plugin and reach everyone using Claudex.</p>
      </div>
      <span className="customize-build-actions">
        <button
          type="button"
          onClick={() => openLink(helpUrl("developer-docs"))}
        >
          Developer docs
          <AppIcon name="ArrowUpRight" size={20} />
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => setSubmissionsPage("list")}
        >
          Submit to the directory
        </button>
      </span>
    </section>
  );
  return (
    <>
      {view === "discover" && tab === "plugins" && (
        <Suspense fallback={null}>
          <ServiceDirectory
            kind="plugin"
            query={query ?? ""}
            onError={onError}
          />
        </Suspense>
      )}
      {tab === "plugins" ? (
        <>
          <PluginsBody
            onUsePlugin={tryPlugin}
            customize
            view={view}
            filter={{
              query: query ?? "",
              category: pluginCategory,
              marketplace: pluginMarketplace,
              sort: "name",
            }}
            plugins={plugins}
            directory={directoryEntries}
            onOpen={openPlugin}
            onAddMarketplace={() => setAddingMarketplace(true)}
            onDiscover={() => changeView("discover")}
            onError={onError}
          />
          {/* While the list loads its skeleton stands alone. */}
          {view === "yours" && (plugins.catalog || plugins.failure) && (
            <>
              {host.kind !== "web" && (
                <section className="customize-section">
                  <h2>In this project</h2>
                  <ul className="customize-rows">
                    <li className="customize-row">
                      <button
                        type="button"
                        className="customize-row-main"
                        disabled
                        title={notAvailable}
                      >
                        <span className="customize-row-tile" aria-hidden="true">
                          <Folder size={16} />
                        </span>
                        <span className="customize-row-text">
                          <strong>Open folder…</strong>
                          <span>
                            Choose the folder you’re working in to see its
                            plugins and install plugins for it.
                          </span>
                        </span>
                      </button>
                    </li>
                  </ul>
                </section>
              )}
              {buildForDirectory}
            </>
          )}
        </>
      ) : tab === "connectors" && view === "discover" ? (
        <Suspense fallback={null}>
          <CustomizeConnectors
            settings={settings}
            view={view}
            query={query ?? ""}
            category={
              route?.section === "connectors"
                ? route.category
                : connectorCategory
            }
            filterType={
              connectorListing ? shownConnectorDirectoryType : undefined
            }
            directoryScope={!!connectorListing}
            onOpenDirectory={openConnectorDirectory}
            onFilterAvailability={setConnectorFilterMetadata}
            onOpenCategory={openConnectorCategory}
            onOpen={openConnector}
            onBack={closeConnector}
            onOpenSettings={onOpenSettings}
            onError={onError}
          />
        </Suspense>
      ) : tab === "connectors" ? (
        <>
          <Connectors
            servers={servers}
            rows={connectorRows}
            settings={settings}
            searching={searching}
            status={connectorStatus}
            loadFailed={serversError}
            onRetry={() => void loadServers()}
            programLabel={offers.programLabel}
            onDiscover={() => changeView("discover")}
            customConnectors={offers.addConnectors && policy.localMcpEditing}
          />
          {buildForDirectory}
        </>
      ) : view === "discover" ? (
        <PluginsBody
          onUsePlugin={tryPlugin}
          customize
          noun="skills"
          view="discover"
          filter={{
            query: "",
            category: pluginCategory,
            marketplace: pluginMarketplace,
            sort: "name",
          }}
          plugins={plugins}
          directory={directoryEntries}
          onOpen={openPlugin}
          onAddMarketplace={() => setAddingMarketplace(true)}
          onDiscover={() => changeView("discover")}
          onError={onError}
        />
      ) : (
        <CustomizeYoursSkills
          changeView={changeView}
          loadSkills={loadSkills}
          menu={menu}
          openSkill={openSkill}
          origin={origin}
          own={own}
          rowAnchor={rowAnchor}
          searching={searching}
          setMenu={setMenu}
          setOrigin={setOrigin}
          setQuery={setQuery}
          skills={skills}
          skillsError={skillsError}
          yours={yours}
        />
      )}
    </>
  );
}
