import { useState, useEffect, useRef, useMemo } from "react";
import type {
  Tab,
  View,
  ConnectorType,
  ConnectorStatus,
  OpenMenu,
  CustomizeOwner,
} from "./CustomizePage";
import type { SkillOrigin, SkillSort } from "./customize-list";
import { useLatestRead } from "./useLatestRead";
import type {
  CustomizeSkill,
  PluginEntry,
} from "../../../shared/collections-api";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { StarterSkill } from "./starter-skills";
import type { SkillDetailView } from "./InstalledSkillPage";
import type {
  ConnectorDirectoryType,
  ConnectorFilterAvailability,
} from "../../settings/directory/connector-categories";
import {
  connectorCategory as publishedConnectorCategory,
  connectorDirectoryTypes,
} from "../../settings/directory/connector-categories";
import { connectorFilterTitle } from "../../settings/tabs/ConnectorDirectory";
import { formatText, t } from "../../i18n";
import { searchDelay, catalogQuery } from "./customize-list";
import { usePlugins } from "../../plugins/usePlugins";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import { isApprovedDirectoryEntries } from "../../../shared/connectors-catalogue";
import { useWideColumn } from "../useWideColumn";
import type { CustomizePlace } from "../../web/customize-route";
import { useCustomizeEffects } from "./useCustomizeEffects";

/** What useCustomizeState needs from CustomizePage.tsx. */
export interface UseCustomizeStateKit {
  customizeLive: React.RefObject<boolean>;
  displayedSkillPath: React.RefObject<string | undefined>;
  locale: string;
  onConfirmRemove: (skill: CustomizeSkill, remove: () => Promise<void>) => void;
  onError: (error: unknown) => void;
  onRouteChange: ((place: CustomizePlace) => void) | undefined;
  onUsePlugin:
    | ((
        id: string,
        current?: (() => boolean) | undefined,
      ) => void | Promise<void>)
    | undefined;
  owner: CustomizeOwner;
  route: CustomizePlace | undefined;
  skillIntent: React.RefObject<number>;
}

export function useCustomizeState(kit: UseCustomizeStateKit) {
  const {
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
  } = kit;
  const [tab, setTab] = useState<Tab>(route?.section ?? "skills");
  useEffect(() => {
    const open = () => {
      skillIntent.current++;
      setTab("skills");
      if (route) onRouteChange?.({ section: "skills", view: "yours" });
    };
    window.addEventListener("claudex:customize-skills", open);
    return () => window.removeEventListener("claudex:customize-skills", open);
  }, [!!route, onRouteChange]);
  const [view, setView] = useState<View>(route?.view ?? "discover");
  // c27f32a39:89–125: established list context survives upload/Back;
  // a direct upload without list context lands in Yours.
  const pluginListView = useRef<View | undefined>(undefined);
  if (tab === "plugins" && !route?.pluginPage) pluginListView.current = view;

  const [query, setQuery] = useState<string | null>(null);
  const [origin, setOrigin] = useState<SkillOrigin>("all");
  const [sort, setSort] = useState<SkillSort>("edited");
  const [connectorType, setConnectorType] = useState<ConnectorType>("all");
  const [connectorStatus, setConnectorStatus] =
    useState<ConnectorStatus>("all");
  // The page asks the host only while it is shown.
  const readable = () =>
    Boolean(owner.bridge) && customizeLive.current && owner.current();
  const skillList = useLatestRead<CustomizeSkill[]>({
    read: async () => (await owner.bridge!.customizeSkills()) ?? [],
    alive: readable,
    initialLoading: true,
    empty: [],
    onError,
  });
  const serverList = useLatestRead<McpServerState[]>({
    read: async () => (await owner.bridge!.mcpServers())?.servers ?? [],
    alive: readable,
    initialLoading: true,
    empty: [],
    onError,
  });
  const {
    value: skills,
    setValue: setSkills,
    error: skillsError,
    setError: setSkillsError,
    loading: skillsLoading,
    load: loadSkills,
  } = skillList;
  const {
    value: servers,
    error: serversError,
    loading: serversLoading,
    load: loadServers,
  } = serverList;
  /** A list that could not be read shows an error with Retry, not an empty state. */
  const [menu, setMenu] = useState<OpenMenu>();
  const [busy, setBusy] = useState<string>();
  const [creating, setCreating] = useState(false);
  // Duplicate or Rename from a row's menu.
  const [naming, setNaming] = useState<{
    kind: "duplicate" | "rename";
    skill: CustomizeSkill;
  }>();
  const [detail, setDetail] = useState<StarterSkill | CustomizeSkill>();
  const [skillView, setSkillView] = useState<SkillDetailView>(
    route?.detailView ?? "overview",
  );
  const [connectorDetail, setConnectorDetail] = useState<string>();
  const [connectorCategory, setConnectorCategory] = useState<string>();
  const [connectorDirectoryScope, setConnectorDirectoryScope] =
    useState<"all">();
  const [connectorDirectoryType, setConnectorDirectoryType] =
    useState<ConnectorDirectoryType>("all");
  const [connectorFilterMetadata, setConnectorFilterMetadata] =
    useState<ConnectorFilterAvailability>();
  const activeConnectorCategory =
    tab === "connectors" && view === "discover"
      ? publishedConnectorCategory(
          route?.section === "connectors" ? route.category : connectorCategory,
        )
      : undefined;
  const shownConnectorDirectoryType =
    route?.section === "connectors"
      ? (route.connectorType ?? "all")
      : connectorDirectoryType;
  const shownConnectorScope =
    route?.section === "connectors"
      ? route.connectorScope
      : connectorDirectoryScope;
  const connectorListing =
    tab === "connectors" &&
    view === "discover" &&
    (!!activeConnectorCategory ||
      shownConnectorScope === "all" ||
      shownConnectorDirectoryType !== "all");
  // O16 c8963aace ie uses the marker headings for standalone New/Trending.
  const connectorListingTitle =
    activeConnectorCategory?.label ??
    (shownConnectorScope === "all"
      ? "All connectors"
      : shownConnectorDirectoryType === "new"
        ? "New"
        : shownConnectorDirectoryType === "trending"
          ? "Trending"
          : connectorFilterTitle(shownConnectorDirectoryType));
  const connectorFilterLabels = [
    activeConnectorCategory?.label,
    shownConnectorDirectoryType !== "all"
      ? connectorDirectoryTypes.find(
          (type) => type.id === shownConnectorDirectoryType,
        )?.label
      : undefined,
  ].filter((value): value is string => !!value);
  const connectorFilterLabel = connectorFilterLabels.length
    ? formatText("Filter: {category}", {
        category: new Intl.ListFormat(locale, { type: "unit" }).format(
          connectorFilterLabels.map(t),
        ),
      })
    : t("Filter");
  const connectorListingKey = `${activeConnectorCategory?.id ?? shownConnectorScope ?? ""}/${shownConnectorDirectoryType}`;
  const liveConnectorCategory = useRef(connectorListingKey);
  liveConnectorCategory.current = connectorListingKey;
  const [connectorHeader, setConnectorHeader] = useState<HTMLDivElement | null>(
    null,
  );
  // Plugins come from the agent runtime's marketplaces (loaded on first visit).
  // A search lists plugins on every tab (UnifiedSearch).
  const [settledSearch, setSettledSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setSettledSearch(query?.trim() ?? ""),
      searchDelay,
    );
    return () => clearTimeout(timer);
  }, [query]);
  const canSearchCatalog = catalogQuery(settledSearch) !== "";
  const pluginState = usePlugins(
    owner.current() &&
      (tab === "plugins" ||
        (tab === "skills" && view === "discover") ||
        canSearchCatalog),
  );
  const reloadPlugins = useMemo(
    () => async () => {
      if (owner.current()) await pluginState.reload();
    },
    [owner, pluginState.reload],
  );
  const plugins = { ...pluginState, reload: reloadPlugins };
  const directory = useLatestRead<ApprovedDirectoryEntry[]>({
    read: async () => {
      const entries = await owner.bridge!.listApprovedDirectory();
      if (!isApprovedDirectoryEntries(entries))
        throw new Error("Invalid directory response");
      return entries;
    },
    alive: readable,
    initialLoading: false,
  });
  const {
    value: directoryEntries,
    error: directoryError,
    loading: directoryLoading,
    load: loadDirectory,
  } = directory;
  const [pluginEntry, setPluginEntry] = useState<PluginEntry>();
  const [pluginCategory, setPluginCategory] = useState<string>();
  const [pluginMarketplace, setPluginMarketplace] = useState<string>();
  const [addingMarketplace, setAddingMarketplace] = useState(false);
  const pluginTryLease = useMemo(
    () => ({}),
    [
      tab,
      view,
      detail,
      pluginEntry?.id,
      pluginCategory,
      pluginMarketplace,
      query,
    ],
  );
  const currentPluginTry = useRef(pluginTryLease);
  currentPluginTry.current = pluginTryLease;
  const tryPlugin = onUsePlugin
    ? (id: string, current?: () => boolean) =>
        onUsePlugin(
          id,
          () =>
            owner.current() &&
            currentPluginTry.current === pluginTryLease &&
            current?.() !== false,
        )
    : undefined;

  const [pluginAction, setPluginAction] = useState<
    "upload" | "manage" | "create" | "connector"
  >();
  const [submissionsPage, setSubmissionsPage] = useState<
    "list" | "plugin" | "mcp"
  >();
  const searchInput = useRef<HTMLInputElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const wide = useWideColumn(column);
  const addButton = useRef<HTMLButtonElement>(null);
  const filterAnchor = useRef<HTMLSpanElement>(null);
  const sortAnchor = useRef<HTMLSpanElement>(null);
  const rowAnchor = useRef<HTMLElement | null>(null);
  const {
    addStarter,
    changeSkillView,
    closeSkill,
    confirmRemoveSkill,
    creator,
    installed,
    marketplaceList,
    openConnector,
    openConnectorCategory,
    openPlugin,
    openSkill,
    resetEntries,
    setEnabled,
    shownDetail,
    switchTab,
    upload,
    shownConnector,
    openConnectorDirectory,
    closeConnector,
    routedSkills,
    shownPlugin,
    closePlugin,
    uploading,
    setUploading,
    changeView,
    closeConnectorDirectory,
    connectorRows,
    copyConnectorCategory,
    own,
    skillSortLabel,
    yours,
  } = useCustomizeEffects({
    activeConnectorCategory,
    canSearchCatalog,
    connectorDetail,
    connectorListing,
    connectorListingKey,
    connectorStatus,
    connectorType,
    customizeLive,
    detail,
    directory,
    displayedSkillPath,
    liveConnectorCategory,
    loadDirectory,
    loadServers,
    loadSkills,
    onConfirmRemove,
    onError,
    onRouteChange,
    origin,
    owner,
    pluginEntry,
    plugins,
    query,
    route,
    searchInput,
    serverList,
    servers,
    setAddingMarketplace,
    setBusy,
    setConnectorCategory,
    setConnectorDetail,
    setConnectorDirectoryScope,
    setConnectorDirectoryType,
    setCreating,
    setDetail,
    setMenu,
    setNaming,
    setOrigin,
    setPluginAction,
    setPluginCategory,
    setPluginEntry,
    setPluginMarketplace,
    setQuery,
    setSkillView,
    setSort,
    setSubmissionsPage,
    setTab,
    setView,
    shownConnectorDirectoryType,
    shownConnectorScope,
    skillIntent,
    skillList,
    skills,
    sort,
    tab,
    view,
  });
  return {
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
  } as const;
}
