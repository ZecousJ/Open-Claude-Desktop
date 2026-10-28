import { useLocale } from "../../i18n";
import { UploadSkillPage } from "./UploadSkillPage";
import { lazyPiece } from "../../ui/lazy-piece";
import { Suspense } from "react";
import { useContext, useLayoutEffect, useMemo, useRef } from "react";
import { AppContext, type AppController } from "../../app/AppContext";
import type { DesktopAPI, Settings } from "../../../shared/types";
import type { CustomizeSkill } from "../../../shared/collections-api";
import { usePolicy } from "../../policy/PolicyContext";
import { useHost } from "../../host/HostContext";
import { customizeOffers } from "./customize-list";
import { customizeView } from "./CustomizeView";
import { useCustomizeControls } from "./useCustomizeControls";
import { useCustomizeState } from "./useCustomizeState";

const DirectorySubmissionsPage = lazyPiece(
  () => import("./DirectorySubmissionsPage"),
  "DirectorySubmissionsPage",
);
export const ServiceDirectory = lazyPiece(
  () => import("./ServiceDirectory"),
  "ServiceDirectory",
);
export const CustomizeConnectors = lazyPiece(
  () => import("./CustomizeConnectors"),
  "CustomizeConnectors",
);
export const UnifiedSearch = lazyPiece(() => import("./UnifiedSearch"));
const PluginUploadPage = lazyPiece(
  () => import("../../plugins/PluginUploadPage"),
  "PluginUploadPage",
);
export const ManageMarketplacesDialog = lazyPiece(
  () => import("../../plugins/ManageMarketplacesDialog"),
  "ManageMarketplacesDialog",
);
export const CreatePluginDialog = lazyPiece(
  () => import("../../plugins/CreatePluginDialog"),
  "CreatePluginDialog",
);
export const PluginAddConnector = lazyPiece(
  () => import("../../plugins/PluginAddConnector"),
  "PluginAddConnector",
);
import { SkillNameDialog } from "./NameCopyDialog";
import "./customize.css";
import "./customize-yours.css";
import { type CustomizePlace } from "../../web/customize-route";
import { ConnectorHeaderSlot } from "./connector-header-slot";

export type Tab = "skills" | "connectors" | "plugins";
export type View = "yours" | "discover";
export type ConnectorType = "all" | "local" | "remote";
/** The connector table's status filter. */
export type ConnectorStatus = "all" | "connected" | "disconnected";
export type OpenMenu = {
  kind: "add" | "filter" | "sort" | "row";
  rect: DOMRect;
  skill?: CustomizeSkill;
};

/**
 * Customize: the person's skills and the skills included with Claudex, and the
 * MCP connectors this computer runs. Discover also browses the original's
 * directory (New, Most installed, categories, Show all). The connector
 * catalogue merges genuine service publications and delegates mutations to the
 * same controller as Settings. What needs this computer (uploading a folder,
 * Show in folder, Create with Claudex in a local Code chat, adding connectors
 * in the configuration file) is offered only where the host has it
 * (customizeOffers): not in the web app.
 */
interface CustomizePageProps {
  settings: Settings;
  onUseSkill: (name: string) => void;
  onUsePlugin?: (id: string, current?: () => boolean) => void | Promise<void>;
  onOpenSettings: (tab: string) => void;
  /** Asks first, then removes. */
  onConfirmRemove: (skill: CustomizeSkill, remove: () => Promise<void>) => void;
  onError: (error: unknown) => void;
  route?: CustomizePlace;
  onRouteChange?: (place: CustomizePlace) => void;
}

export interface CustomizeOwner {
  bridge: DesktopAPI | undefined;
  accountId: string | undefined;
  controllerScope: object | undefined;
  controllerRef: AppController["currentController"];
  key: number;
  retired: boolean;
  current: () => boolean;
}

/** Account/controller/bridge changes retire all private state before new reads. */
export function CustomizePage(props: CustomizePageProps) {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const latestOwner = useRef<CustomizeOwner | undefined>(undefined);
  const nextOwner = useRef(0);
  let owner = latestOwner.current;
  if (
    !owner ||
    owner.bridge !== bridge ||
    owner.accountId !== app?.accountId ||
    owner.controllerScope !== app?.controllerScope ||
    owner.controllerRef !== app?.currentController
  ) {
    if (owner) owner.retired = true;
    owner = {
      bridge,
      accountId: app?.accountId,
      controllerScope: app?.controllerScope,
      controllerRef: app?.currentController,
      key: ++nextOwner.current,
      retired: false,
      current: () => false,
    };
    const captured = owner;
    captured.current = () => {
      const actor = captured.controllerRef?.current;
      return (
        !captured.retired &&
        latestOwner.current === captured &&
        typeof window !== "undefined" &&
        window.desktop === captured.bridge &&
        (!captured.controllerRef ||
          (!!actor &&
            actor.accountId === captured.accountId &&
            actor.controllerScope === captured.controllerScope))
      );
    };
    latestOwner.current = owner;
  }
  const currentOwner = owner;
  useLayoutEffect(() => {
    latestOwner.current = currentOwner;
    currentOwner.retired = false;
    return () => {
      currentOwner.retired = true;
      if (latestOwner.current === currentOwner) latestOwner.current = undefined;
    };
  }, [currentOwner]);
  return (
    <CustomizePageBody key={currentOwner.key} {...props} owner={currentOwner} />
  );
}

function CustomizePageBody({
  settings,
  onUseSkill,
  onUsePlugin,
  onOpenSettings,
  onConfirmRemove,
  onError: reportError,
  route,
  onRouteChange,
  owner,
}: CustomizePageProps & { owner: CustomizeOwner }) {
  const onError = useMemo(
    () => (error: unknown) => {
      if (owner.current()) reportError(error);
    },
    [owner, reportError],
  );
  const policy = usePolicy();
  const app = useContext(AppContext);
  const host = useHost();
  const offers = customizeOffers(host.capabilities);
  const locale = useLocale();
  const customizeLive = useRef(true);
  const skillIntent = useRef(0);
  const displayedSkillPath = useRef<string | undefined>(undefined);
  const {
    setMenu,
    menu,
    activeConnectorCategory,
    addStarter,
    busy,
    changeSkillView,
    closeSkill,
    confirmRemoveSkill,
    connectorFilterMetadata,
    connectorStatus,
    connectorType,
    creator,
    directoryEntries,
    installed,
    loadSkills,
    marketplaceList,
    openConnector,
    openConnectorCategory,
    openPlugin,
    openSkill,
    origin,
    pluginCategory,
    pluginMarketplace,
    plugins,
    query,
    resetEntries,
    servers,
    setAddingMarketplace,
    setConnectorStatus,
    setConnectorType,
    setCreating,
    setEnabled,
    setNaming,
    setOrigin,
    setPluginAction,
    setPluginCategory,
    setPluginMarketplace,
    setQuery,
    setSort,
    setSubmissionsPage,
    shownConnectorDirectoryType,
    shownDetail,
    skillView,
    skills,
    sort,
    switchTab,
    tab,
    upload,
    view,
    pluginAction,
    pluginListView,
    setTab,
    setView,
    naming,
    shownConnector,
    setConnectorHeader,
    connectorHeader,
    openConnectorDirectory,
    closeConnector,
    skillsError,
    routedSkills,
    setSkillsError,
    setSkills,
    shownPlugin,
    closePlugin,
    submissionsPage,
    uploading,
    setUploading,
    addButton,
    addingMarketplace,
    canSearchCatalog,
    changeView,
    closeConnectorDirectory,
    column,
    connectorCategory,
    connectorFilterLabel,
    connectorListing,
    connectorListingTitle,
    connectorRows,
    copyConnectorCategory,
    creating,
    directoryError,
    directoryLoading,
    filterAnchor,
    loadDirectory,
    loadServers,
    own,
    rowAnchor,
    searchInput,
    serversError,
    serversLoading,
    setConnectorFilterMetadata,
    settledSearch,
    skillSortLabel,
    skillsLoading,
    sortAnchor,
    tryPlugin,
    wide,
    yours,
  } = useCustomizeState({
    customizeLive,
    displayedSkillPath,
    locale,
    onConfirmRemove,
    onError,
    onRouteChange,
    onUsePlugin,
    owner,
    route,
    skillIntent,
  });
  const open = (kind: OpenMenu["kind"], element: HTMLElement | null) =>
    element &&
    setMenu(
      menu?.kind === kind
        ? undefined
        : { kind, rect: element.getBoundingClientRect() },
    );
  const {
    skillDetail,
    addBlocked,
    categoryFilterEntries,
    menuEntries,
    menuWidth,
    openSearchResult,
    searchAdapter,
    searchItems,
    searching,
    unified,
  } = useCustomizeControls({
    activeConnectorCategory,
    addStarter,
    app,
    busy,
    changeSkillView,
    closeSkill,
    confirmRemoveSkill,
    connectorFilterMetadata,
    connectorStatus,
    connectorType,
    creator,
    directoryEntries,
    host,
    installed,
    loadSkills,
    marketplaceList,
    menu,
    offers,
    onConfirmRemove,
    onError,
    onOpenSettings,
    onRouteChange,
    onUseSkill,
    openConnector,
    openConnectorCategory,
    openPlugin,
    openSkill,
    origin,
    owner,
    pluginCategory,
    pluginMarketplace,
    plugins,
    policy,
    query,
    resetEntries,
    route,
    servers,
    setAddingMarketplace,
    setConnectorStatus,
    setConnectorType,
    setCreating,
    setEnabled,
    setNaming,
    setOrigin,
    setPluginAction,
    setPluginCategory,
    setPluginMarketplace,
    setQuery,
    setSort,
    setSubmissionsPage,
    shownConnectorDirectoryType,
    shownDetail,
    skillView,
    skills,
    sort,
    switchTab,
    tab,
    upload,
    view,
  });

  if (owner.bridge && !owner.current()) return null;

  if (
    (route?.section === "plugins" && route.pluginPage === "upload") ||
    pluginAction === "upload"
  )
    return (
      <Suspense
        fallback={
          <div className="customize-loading" role="status">
            Loading…
          </div>
        }
      >
        <PluginUploadPage
          backView={pluginListView.current ?? route?.view ?? "yours"}
          onBack={() => {
            if (!owner.current()) return;
            setPluginAction(undefined);
            setTab("plugins");
            const backView = pluginListView.current ?? route?.view ?? "yours";
            setView(backView);
            onRouteChange?.({ section: "plugins", view: backView });
          }}
          onUploaded={() => {
            if (owner.current()) void plugins.reload();
          }}
        />
      </Suspense>
    );

  if (route && shownDetail && !("instructions" in shownDetail))
    return (
      <div className="customize-view">
        <div style={{ height: 48, flex: "none" }} />
        <div className="customize-scroll customize-skill-scroll">
          <div className="customize-column">{skillDetail}</div>
        </div>
        {naming && (
          <SkillNameDialog
            kind={naming.kind}
            skill={naming.skill}
            onDone={() => void loadSkills()}
            onClose={() => setNaming(undefined)}
          />
        )}
      </div>
    );

  if (tab === "connectors" && shownConnector)
    return (
      <div className="customize-view">
        <div
          className="customize-connector-pane-header"
          style={{ height: 48, flex: "none" }}
        >
          <div
            className="customize-connector-pane-actions"
            ref={setConnectorHeader}
          />
        </div>
        <div className="customize-scroll">
          <div className="customize-column">
            <ConnectorHeaderSlot.Provider value={connectorHeader}>
              <Suspense fallback={null}>
                <CustomizeConnectors
                  settings={settings}
                  view={view}
                  connectorId={shownConnector}
                  onOpenDirectory={openConnectorDirectory}
                  onOpenCategory={openConnectorCategory}
                  onOpen={openConnector}
                  onBack={closeConnector}
                  onOpenSettings={onOpenSettings}
                  onError={onError}
                />
              </Suspense>
            </ConnectorHeaderSlot.Provider>
          </div>
        </div>
      </div>
    );

  if (route?.detailId && route.section === "skills" && !shownDetail)
    return (
      <div className="customize-view">
        <div className="customize-scroll">
          <div className="customize-column" role="status">
            {skillsError
              ? "Couldn’t load your skills."
              : skills === undefined
                ? "Loading skills"
                : routedSkills && routedSkills.length > 1
                  ? "More than one skill has this name."
                  : "Skill not found"}
            {skillsError && (
              <button
                type="button"
                onClick={() => {
                  setSkillsError(false);
                  setSkills(undefined);
                  void loadSkills();
                }}
              >
                Try again
              </button>
            )}
            <button type="button" onClick={closeSkill}>
              Your skills
            </button>
          </div>
        </div>
      </div>
    );
  if (route?.detailId && route.section === "plugins" && !shownPlugin)
    return (
      <div className="customize-view">
        <div className="customize-scroll">
          <div className="customize-column" role="status">
            {plugins.failure ??
              (plugins.catalog ? "Plugin not found" : "Loading plugins…")}
            {plugins.failure && (
              <button type="button" onClick={() => void plugins.reload()}>
                Try again
              </button>
            )}
            <button type="button" onClick={closePlugin}>
              Your plugins
            </button>
          </div>
        </div>
      </div>
    );

  if (submissionsPage)
    return (
      <Suspense fallback={null}>
        <DirectorySubmissionsPage
          settings={settings}
          kind={submissionsPage === "list" ? undefined : submissionsPage}
          onBack={() => setSubmissionsPage(undefined)}
        />
      </Suspense>
    );
  if (uploading)
    return (
      <div className="customize-view">
        <div className="customize-scroll">
          <div className="customize-column">
            <UploadSkillPage
              onBack={() => setUploading(false)}
              onUploaded={() => {
                setUploading(false);
                setTab("skills");
                setView("yours");
                if (route)
                  onRouteChange?.({ section: "skills", view: "yours" });
                void loadSkills();
              }}
            />
          </div>
        </div>
      </div>
    );
  const pageView = customizeView({
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
  });
  return pageView;
}
