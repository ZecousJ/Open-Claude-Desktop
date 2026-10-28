import { useLayoutEffect, useEffect, useMemo, useState } from "react";
import type {
  View,
  Tab,
  ConnectorStatus,
  ConnectorType,
  CustomizeOwner,
  OpenMenu,
} from "./CustomizePage";
import type { StarterSkill } from "./starter-skills";
import type {
  CustomizeSkill,
  PluginEntry,
  PluginCatalog,
  PluginCopy,
} from "../../../shared/collections-api";
import type { SkillDetailView } from "./InstalledSkillPage";
import type { ConnectorDirectoryType } from "../../settings/directory/connector-categories";
import { customizePath } from "../../web/customize-route";
import { showToast } from "../../ui/toast-store";
import { t, formatText } from "../../i18n";
import { sections, visibleSkills, searchable } from "./customize-list";
import type { PageMenuEntry } from "../PageMenu";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { CustomizePlace } from "../../web/customize-route";
import type { SkillOrigin, SkillSort } from "./customize-list";
import type { McpServerState } from "../../../shared/settings-desktop-api";

/** What useCustomizeEffects needs from useCustomizeState.tsx. */
export interface UseCustomizeEffectsKit {
  activeConnectorCategory: { id: string; label: string } | undefined;
  canSearchCatalog: boolean;
  connectorDetail: string | undefined;
  connectorListing: boolean;
  connectorListingKey: string;
  connectorStatus: ConnectorStatus;
  connectorType: ConnectorType;
  customizeLive: React.RefObject<boolean>;
  detail: StarterSkill | CustomizeSkill | undefined;
  directory: {
    value: ApprovedDirectoryEntry[] | undefined;
    setValue: React.Dispatch<
      React.SetStateAction<ApprovedDirectoryEntry[] | undefined>
    >;
    error: boolean;
    setError: React.Dispatch<React.SetStateAction<boolean>>;
    loading: boolean;
    load: () => Promise<void>;
    cancel: () => void;
  };
  displayedSkillPath: React.RefObject<string | undefined>;
  liveConnectorCategory: React.RefObject<string>;
  loadDirectory: () => Promise<void>;
  loadServers: () => Promise<void>;
  loadSkills: () => Promise<void>;
  onConfirmRemove: (skill: CustomizeSkill, remove: () => Promise<void>) => void;
  onError: (error: unknown) => void;
  onRouteChange: ((place: CustomizePlace) => void) | undefined;
  origin: SkillOrigin;
  owner: CustomizeOwner;
  pluginEntry: PluginEntry | undefined;
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
  query: string | null;
  route: CustomizePlace | undefined;
  searchInput: React.RefObject<HTMLInputElement | null>;
  serverList: {
    value: McpServerState[] | undefined;
    setValue: React.Dispatch<
      React.SetStateAction<McpServerState[] | undefined>
    >;
    error: boolean;
    setError: React.Dispatch<React.SetStateAction<boolean>>;
    loading: boolean;
    load: () => Promise<void>;
    cancel: () => void;
  };
  servers: McpServerState[] | undefined;
  setAddingMarketplace: React.Dispatch<React.SetStateAction<boolean>>;
  setBusy: React.Dispatch<React.SetStateAction<string | undefined>>;
  setConnectorCategory: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  setConnectorDetail: React.Dispatch<React.SetStateAction<string | undefined>>;
  setConnectorDirectoryScope: React.Dispatch<
    React.SetStateAction<"all" | undefined>
  >;
  setConnectorDirectoryType: React.Dispatch<
    React.SetStateAction<
      | "all"
      | "trending"
      | "new"
      | "verified"
      | "community"
      | "inChatUi"
      | "desktopExtension"
    >
  >;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setDetail: React.Dispatch<
    React.SetStateAction<StarterSkill | CustomizeSkill | undefined>
  >;
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
  setPluginCategory: React.Dispatch<React.SetStateAction<string | undefined>>;
  setPluginEntry: React.Dispatch<React.SetStateAction<PluginEntry | undefined>>;
  setPluginMarketplace: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setSkillView: React.Dispatch<React.SetStateAction<SkillDetailView>>;
  setSort: React.Dispatch<React.SetStateAction<SkillSort>>;
  setSubmissionsPage: React.Dispatch<
    React.SetStateAction<"list" | "plugin" | "mcp" | undefined>
  >;
  setTab: React.Dispatch<React.SetStateAction<Tab>>;
  setView: React.Dispatch<React.SetStateAction<View>>;
  shownConnectorDirectoryType:
    | "all"
    | "trending"
    | "new"
    | "verified"
    | "community"
    | "inChatUi"
    | "desktopExtension";
  shownConnectorScope: "all" | undefined;
  skillIntent: React.RefObject<number>;
  skillList: {
    value: CustomizeSkill[] | undefined;
    setValue: React.Dispatch<
      React.SetStateAction<CustomizeSkill[] | undefined>
    >;
    error: boolean;
    setError: React.Dispatch<React.SetStateAction<boolean>>;
    loading: boolean;
    load: () => Promise<void>;
    cancel: () => void;
  };
  skills: CustomizeSkill[] | undefined;
  sort: SkillSort;
  tab: Tab;
  view: View;
}

export function useCustomizeEffects(kit: UseCustomizeEffectsKit) {
  const {
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
  } = kit;
  useLayoutEffect(() => {
    if (!route) return;
    skillIntent.current++;
    setTab(route.section);
    setView(route.view);
    setQuery(null);
    setMenu(undefined);
    setDetail(undefined);
    setPluginEntry(undefined);
    setSkillView(route.detailView ?? "overview");
    setUploading(false);
    setCreating(false);
    setNaming(undefined);
    setSubmissionsPage(undefined);
    setPluginAction(undefined);
    setAddingMarketplace(false);
  }, [
    route?.section,
    route?.view,
    route?.detailId,
    route?.detailView,
    route?.pluginPage,
    route?.category,
    route?.connectorType,
  ]);
  const changeView = (next: View) => {
    skillIntent.current++;
    setView(next);
    if (route) onRouteChange?.({ section: tab, view: next });
  };
  const openSkill = (skill: StarterSkill | CustomizeSkill) => {
    skillIntent.current++;
    setDetail(skill);
    setSkillView("overview");
    if (route && !("instructions" in skill))
      onRouteChange?.({
        section: "skills",
        view: "yours",
        detailId: skill.name,
      });
  };
  const closeSkill = () => {
    skillIntent.current++;
    setDetail(undefined);
    if (route?.section === "skills" && route.detailId)
      onRouteChange?.({ section: "skills", view: route.view });
  };
  const changeSkillView = (next: SkillDetailView) => {
    skillIntent.current++;
    setSkillView(next);
    if (route?.section === "skills" && route.detailId)
      onRouteChange?.({ ...route, detailView: next });
  };
  const openPlugin = (plugin: PluginEntry) => {
    setPluginEntry(plugin);
    if (route)
      onRouteChange?.({ section: "plugins", view, detailId: plugin.id });
  };
  const closePlugin = () => {
    setPluginEntry(undefined);
    if (route?.section === "plugins" && route.detailId)
      onRouteChange?.({ section: "plugins", view: route.view });
  };
  const openConnector = (id: string) => {
    setConnectorDetail(id);
    if (route) onRouteChange?.({ section: "connectors", view, detailId: id });
  };
  const closeConnector = () => {
    setConnectorDetail(undefined);
    if (route) onRouteChange?.({ section: "connectors", view });
  };
  const openConnectorDirectory = (type: ConnectorDirectoryType = "all") => {
    setConnectorDetail(undefined);
    setConnectorCategory(undefined);
    setConnectorDirectoryScope(type === "all" ? "all" : undefined);
    setConnectorDirectoryType(type);
    setView("discover");
    if (route)
      onRouteChange?.({
        section: "connectors",
        view: "discover",
        ...(type === "all"
          ? { connectorScope: "all" }
          : { connectorType: type }),
      });
  };
  const closeConnectorDirectory = () => {
    setConnectorCategory(undefined);
    setConnectorDirectoryScope(undefined);
    setConnectorDirectoryType("all");
    if (route) onRouteChange?.({ section: "connectors", view: "discover" });
  };
  const openConnectorCategory = (
    category?: string,
    type = shownConnectorDirectoryType,
  ) => {
    setConnectorDetail(undefined);
    setConnectorCategory(category);
    setConnectorDirectoryScope(category ? undefined : "all");
    setConnectorDirectoryType(type);
    setView("discover");
    if (route)
      onRouteChange?.({
        section: "connectors",
        view: "discover",
        ...(category ? { category } : { connectorScope: "all" }),
        ...(type !== "all" ? { connectorType: type } : {}),
      });
  };
  const copyConnectorCategory = () => {
    if (!connectorListing || !owner.bridge || !owner.current()) return;
    const key = connectorListingKey;
    const path = customizePath({
      section: "connectors",
      view: "discover",
      category: activeConnectorCategory?.id,
      connectorScope: shownConnectorScope,
      connectorType: shownConnectorDirectoryType,
    });
    void owner.bridge
      .copyText(new URL(path, location.href).href)
      .then(() => {
        if (
          customizeLive.current &&
          owner.current() &&
          liveConnectorCategory.current === key
        )
          showToast(t("Link copied"));
      })
      .catch(onError);
  };

  useEffect(() => {
    customizeLive.current = true;
    const invalidate = () => {
      skillIntent.current++;
    };
    window.addEventListener("popstate", invalidate, true);
    window.addEventListener("hashchange", invalidate, true);
    void loadSkills();
    void loadServers();
    return () => {
      customizeLive.current = false;
      skillIntent.current++;
      skillList.cancel();
      serverList.cancel();
      window.removeEventListener("popstate", invalidate, true);
      window.removeEventListener("hashchange", invalidate, true);
    };
  }, []);
  useEffect(() => {
    // The curation behind Discover's blocks (after the effect above marks
    // the page live, which StrictMode's second mount needs); a search reads it afresh for
    // the published entries it lists.
    if (view === "discover" && tab !== "connectors") void loadDirectory();
    return directory.cancel;
  }, [view, tab !== "connectors", canSearchCatalog]);
  useEffect(() => {
    if (query !== null) searchInput.current?.focus();
  }, [query !== null]);
  // Search, filters and menus belong to one tab.
  const switchTab = (next: Tab) => {
    skillIntent.current++;
    setTab(next);
    setQuery(null);
    setMenu(undefined);
    setPluginCategory(undefined);
    setPluginMarketplace(undefined);
    setConnectorDetail(undefined);
    if (route) onRouteChange?.({ section: next, view });
  };

  const installed = new Set((skills ?? []).map((skill) => skill.name));
  // An installed skill's details follow the list (Turn off, Turn on).
  const routedSkills =
    route?.section === "skills" && route.detailId
      ? skills?.filter((skill) => skill.name === route.detailId)
      : undefined;
  const shownDetail =
    route?.section === "skills" && route.detailId
      ? routedSkills?.length === 1
        ? routedSkills[0]
        : undefined
      : detail && !("instructions" in detail)
        ? (skills ?? []).find((skill) => skill.path === detail.path)
        : detail;
  displayedSkillPath.current =
    shownDetail && !("instructions" in shownDetail)
      ? shownDetail.path
      : undefined;
  const shownPlugin =
    route?.section === "plugins" && route.detailId
      ? plugins.catalog?.plugins.find((plugin) => plugin.id === route.detailId)
      : pluginEntry;
  const shownConnector =
    route?.section === "connectors" ? route.detailId : connectorDetail;
  // "Create skill with Claudex" needs the runtime's skill-creator skill.
  const creator = (skills ?? []).find(
    (skill) => skill.name === "skill-creator" && skill.enabled,
  );
  const own = (skills ?? []).filter(
    sections.find((section) => section.id === "you")!.test,
  );
  const yours = useMemo(
    () => visibleSkills(skills ?? [], query ?? "", origin, sort),
    [skills, query, origin, sort],
  );
  const connectorRows = (servers ?? []).filter(
    (server) =>
      (connectorType === "all" ||
        (connectorType === "remote") === Boolean(server.url)) &&
      (connectorStatus === "all" ||
        (connectorStatus === "connected") === (server.state === "ready")) &&
      searchable([{ name: server.name, description: "" }], query ?? "").length,
  );
  // Filters and sort that differ from what the page opens with (the skills
  // menus then end with Reset filters and sort).
  const skillsDeviate = origin !== "all" || sort !== "edited";
  const skillSortLabel =
    view === "yours"
      ? formatText("Sort by {sort}", {
          sort: t(sort === "edited" ? "Last edited" : "Name"),
        })
      : t("Sort");
  const resetSkills = () => {
    setOrigin("all");
    setSort("edited");
  };
  const resetEntries: PageMenuEntry[] = skillsDeviate
    ? [
        { separator: true },
        { label: "Reset filters and sort", onSelect: resetSkills },
      ]
    : [];

  async function addStarter(skill: StarterSkill) {
    setBusy(skill.name);
    try {
      await window.desktop.saveSkill({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
      });
      await loadSkills();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(undefined);
    }
  }
  // Upload skill opens the Upload a skill page.
  const [uploading, setUploading] = useState(false);
  const upload = () => setUploading(true);
  async function setEnabled(skill: CustomizeSkill, enabled: boolean) {
    try {
      await window.desktop.setSkillEnabled(skill.path, enabled);
      await loadSkills();
    } catch (error) {
      if (customizeLive.current) onError(error);
    }
  }
  const confirmRemoveSkill = (skill: CustomizeSkill) => {
    const intent = skillIntent.current;
    onConfirmRemove(skill, async () => {
      await window.desktop.deleteSkill(skill.path);
      if (
        customizeLive.current &&
        skillIntent.current === intent &&
        displayedSkillPath.current === skill.path
      )
        closeSkill();
      await loadSkills();
    });
  };
  // Plugins, and Skills → Discover, list the marketplaces' plugins: their
  // filters are marketplace and category, their only order is by name.
  const marketplaceList =
    tab === "plugins" || (tab === "skills" && view === "discover");
  return {
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
  } as const;
}
