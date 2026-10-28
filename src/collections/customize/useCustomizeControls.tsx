import type { MenuEntry } from "../../ui/Menu";
import {
  connectorCategoryGroups,
  connectorDirectoryTypes,
} from "../../settings/directory/connector-categories";
import { formatText, t } from "../../i18n";
import { customizeMenus } from "./customize-menus";
import { mcpEditingRefusal } from "../../../shared/client-policy";
import { useMemo } from "react";
import { createCustomizeSearchAdapter } from "./customize-search-adapter";
import type {
  CustomizeSearchAPI,
  CustomizeSearchHit,
} from "../../../shared/customize-search";
import { normalizeSearchText } from "./customize-list";
import type { SearchItem } from "./UnifiedSearch";
import { directoryConnectors } from "../../../shared/connectors-catalogue";
import { SkillDetail } from "./SkillDetail";
import { customizePath } from "../../web/customize-route";
import type { StarterSkill } from "./starter-skills";
import type { AppController } from "../../app/AppContext";
import type { SkillDetailView } from "./InstalledSkillPage";
import type {
  CustomizeSkill,
  PluginEntry,
  PluginCatalog,
  PluginCopy,
} from "../../../shared/collections-api";
import type { ConnectorFilterAvailability } from "../../settings/directory/connector-categories";
import type {
  ConnectorStatus,
  ConnectorType,
  OpenMenu,
  CustomizeOwner,
  Tab,
  View,
} from "./CustomizePage";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { CustomizePlace } from "../../web/customize-route";
import type { SkillOrigin, SkillSort, CustomizeOffers } from "./customize-list";
import type { PageMenuEntry } from "../PageMenu";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { HostInfo } from "../../../shared/host";
import type { ClientPolicy } from "../../../shared/client-policy";

/** What useCustomizeControls needs from CustomizePage.tsx. */
export interface UseCustomizeControlsKit {
  activeConnectorCategory: { id: string; label: string } | undefined;
  addStarter: (skill: StarterSkill) => Promise<void>;
  app: AppController | undefined;
  busy: string | undefined;
  changeSkillView: (next: SkillDetailView) => void;
  closeSkill: () => void;
  confirmRemoveSkill: (skill: CustomizeSkill) => void;
  connectorFilterMetadata: ConnectorFilterAvailability | undefined;
  connectorStatus: ConnectorStatus;
  connectorType: ConnectorType;
  creator: CustomizeSkill | undefined;
  directoryEntries: ApprovedDirectoryEntry[] | undefined;
  host: HostInfo;
  installed: Set<string>;
  loadSkills: () => Promise<void>;
  marketplaceList: boolean;
  menu: OpenMenu | undefined;
  offers: CustomizeOffers;
  onConfirmRemove: (skill: CustomizeSkill, remove: () => Promise<void>) => void;
  onError: (error: unknown) => void;
  onOpenSettings: (tab: string) => void;
  onRouteChange: ((place: CustomizePlace) => void) | undefined;
  onUseSkill: (name: string) => void;
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
  openPlugin: (plugin: PluginEntry) => void;
  openSkill: (skill: CustomizeSkill | StarterSkill) => void;
  origin: SkillOrigin;
  owner: CustomizeOwner;
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
  resetEntries: PageMenuEntry[];
  route: CustomizePlace | undefined;
  servers: McpServerState[] | undefined;
  setAddingMarketplace: React.Dispatch<React.SetStateAction<boolean>>;
  setConnectorStatus: React.Dispatch<React.SetStateAction<ConnectorStatus>>;
  setConnectorType: React.Dispatch<React.SetStateAction<ConnectorType>>;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setEnabled: (skill: CustomizeSkill, enabled: boolean) => Promise<void>;
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
  setPluginCategory: React.Dispatch<React.SetStateAction<string | undefined>>;
  setPluginMarketplace: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setSort: React.Dispatch<React.SetStateAction<SkillSort>>;
  setSubmissionsPage: React.Dispatch<
    React.SetStateAction<"list" | "plugin" | "mcp" | undefined>
  >;
  shownConnectorDirectoryType:
    | "all"
    | "trending"
    | "new"
    | "verified"
    | "community"
    | "inChatUi"
    | "desktopExtension";
  shownDetail: CustomizeSkill | StarterSkill | undefined;
  skillView: SkillDetailView;
  skills: CustomizeSkill[] | undefined;
  sort: SkillSort;
  switchTab: (next: Tab) => void;
  tab: Tab;
  upload: () => void;
  view: View;
}

export function useCustomizeControls(kit: UseCustomizeControlsKit) {
  const {
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
  } = kit;
  const categoryFilterEntries = (): MenuEntry[] => [
    {
      label: "All categories",
      checked: !activeConnectorCategory,
      checkedRole: "radio",
      onSelect: () => openConnectorCategory(undefined),
    },
    // All categories, a taxonomy section, and Everyday life are separate
    // groups, each followed by a separator.
    { separator: true },
    ...connectorCategoryGroups().flatMap((group): MenuEntry[] => [
      ...(group.prefix === "everyday-life-"
        ? [{ separator: true as const }]
        : []),
      {
        label: group.label,
        value: activeConnectorCategory?.id.startsWith(group.prefix)
          ? activeConnectorCategory.label
          : undefined,
        submenu: group.categories.map((item) => ({
          label: item.label,
          checked: item.id === activeConnectorCategory?.id,
          checkedRole: "radio" as const,
          onSelect: () => openConnectorCategory(item.id),
        })),
      },
    ]),
    { separator: true },
    { heading: "Type" },
    ...connectorDirectoryTypes.map((type) => {
      const field = "field" in type ? type.field : undefined;
      const available = !field || connectorFilterMetadata?.[field] === true;
      return {
        label: type.label,
        checked: type.id === shownConnectorDirectoryType,
        checkedRole: "radio" as const,
        disabled: !available,
        title: available
          ? undefined
          : formatText("{type} isn’t available for this directory.", {
              type: t(type.label),
            }),
        onSelect: () =>
          openConnectorCategory(activeConnectorCategory?.id, type.id),
      };
    }),
  ];
  const menuEntries = customizeMenus({
    app,
    connectorStatus,
    connectorType,
    creator,
    host,
    loadSkills,
    marketplaceList,
    offers,
    onConfirmRemove,
    onError,
    onOpenSettings,
    onRouteChange,
    origin,
    owner,
    pluginCategory,
    pluginMarketplace,
    plugins,
    policy,
    resetEntries,
    route,
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
    setSort,
    setSubmissionsPage,
    sort,
    tab,
    upload,
    view,
  });
  const menuWidth =
    menu?.kind === "add"
      ? tab === "skills"
        ? 182
        : 236
      : menu?.kind === "sort"
        ? 172
        : menu?.kind === "row"
          ? 176
          : 200;
  const addBlocked =
    tab === "connectors"
      ? view === "discover" && !offers.addConnectors
        ? "Custom connectors aren’t available for this account."
        : !policy.localMcpEditing
          ? mcpEditingRefusal(policy)
          : undefined
      : undefined;
  const searchAdapter = useMemo(
    () =>
      createCustomizeSearchAdapter(
        owner.bridge as Partial<CustomizeSearchAPI> | undefined,
        () => owner.current(),
      ),
    [owner],
  );
  const searching = normalizeSearchText(query ?? "") !== "";
  // Discover (and Connectors) search everything in one list (UnifiedSearch).
  const unified = searching && view === "discover" && tab !== "connectors";
  const searchItems: SearchItem[] = unified
    ? [
        ...(skills ?? []).map((skill) => ({
          key: `skill:${skill.path}`,
          kind: "skill" as const,
          name: skill.name,
          description: skill.description,
          yours: true,
          open: () => {
            switchTab("skills");
            openSkill(skill);
          },
        })),
        ...(plugins.catalog?.plugins ?? []).map((plugin) => ({
          key: `plugin:${plugin.id}`,
          kind: "plugin" as const,
          name: plugin.title,
          description: plugin.description,
          yours: plugin.installed,
          open: () => {
            switchTab("plugins");
            openPlugin(plugin);
          },
        })),
        ...(servers ?? []).map((server) => ({
          key: `server:${server.name}`,
          kind: "connector" as const,
          name: server.displayName ?? server.name,
          yours: true,
          open: () => {
            switchTab("connectors");
            setQuery(server.name);
          },
        })),
        ...(directoryEntries ?? [])
          .filter((entry) => entry.kind === "plugin")
          .map((entry) => ({
            key: `published:${entry.id}`,
            kind: "plugin" as const,
            name: entry.name,
            description: entry.description,
            yours: false,
            open: () =>
              void window.desktop.openExternal(entry.url).catch(onError),
          })),
        ...directoryConnectors(directoryEntries ?? [])
          .filter(
            (connector) =>
              !(servers ?? []).some(
                (server) =>
                  server.name === connector.id ||
                  (server.displayName ?? server.name) === connector.name,
              ),
          )
          .map((connector) => ({
            key: `directory:${connector.id}`,
            kind: "connector" as const,
            name: connector.name,
            description: connector.description,
            yours: false,
            open: () => {
              switchTab("connectors");
              openConnector(connector.id);
            },
          })),
      ]
    : [];
  const openSearchResult = (hit: CustomizeSearchHit) => {
    if (!owner.current()) return;
    const existing = searchItems.find((item) => item.key === hit.key);
    if (existing) {
      existing.open();
      return;
    }
    const target = hit.target;
    if (target.type === "skill") {
      const skill = skills?.find((entry) => entry.path === target.path);
      if (skill) {
        switchTab("skills");
        openSkill(skill);
      } else onError(new Error("That skill is no longer installed."));
    } else if (target.type === "plugin") {
      const plugin = plugins.catalog?.plugins.find(
        (entry) => entry.id === target.id,
      );
      if (plugin) {
        switchTab("plugins");
        openPlugin(plugin);
      } else onError(new Error("That plugin is no longer available."));
    } else if (target.type === "connector") {
      switchTab("connectors");
      openConnector(target.id);
    } else void owner.bridge?.openExternal(target.url).catch(onError);
  };
  const skillDetail = shownDetail && (
    <SkillDetail
      skill={shownDetail}
      added={installed.has(shownDetail.name)}
      busy={busy !== undefined}
      onClose={closeSkill}
      onAdd={async () => {
        if ("instructions" in shownDetail) await addStarter(shownDetail);
      }}
      onTry={() => {
        closeSkill();
        onUseSkill(shownDetail.name);
      }}
      onToggle={(skill) => setEnabled(skill, !skill.enabled)}
      onReveal={
        offers.reveal
          ? (skill) =>
              void window.desktop.revealSkill(skill.path).catch(onError)
          : undefined
      }
      onRemove={confirmRemoveSkill}
      onDuplicate={(skill) => setNaming({ kind: "duplicate", skill })}
      page={
        "instructions" in shownDetail || !route
          ? undefined
          : {
              view:
                route?.section === "skills" && route.detailId
                  ? (route.detailView ?? "overview")
                  : skillView,
              onViewChange: changeSkillView,
              links: {
                back: customizePath({ section: "skills", view: "yours" }),
                overview: customizePath({
                  section: "skills",
                  view: "yours",
                  detailId: shownDetail.name,
                }),
                contents: customizePath({
                  section: "skills",
                  view: "yours",
                  detailId: shownDetail.name,
                  detailView: "contents",
                }),
              },
            }
      }
    />
  );
  return {
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
  } as const;
}
