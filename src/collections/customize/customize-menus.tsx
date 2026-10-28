import type { OpenMenu } from "./CustomizePage";
import type { PageMenuEntry } from "../PageMenu";
import {
  Upload,
  Pencil,
  MessageCircleMore,
  Link,
  Send,
  SquareTerminal,
  Copy,
  FolderOpen,
  Trash2,
} from "../../ui/glyphs";
import { notAvailable } from "../../settings/unavailable";
import { Video, Power } from "lucide-react";
import { pluginAddMenu } from "../../plugins/plugin-menu";
import { mcpEditingRefusal } from "../../../shared/client-policy";
import { t, formatText } from "../../i18n";
import { pluginCategoriesOf } from "../../plugins/plugin-model";
import { discoverSortLabels } from "./CustomizeDirectory";
import type { PluginSort } from "./CustomizeDirectory";
import type { AppController } from "../../app/AppContext";
import type {
  ConnectorStatus,
  ConnectorType,
  CustomizeOwner,
  Tab,
  View,
} from "./CustomizePage";
import type {
  CustomizeSkill,
  PluginCatalog,
  PluginCopy,
} from "../../../shared/collections-api";
import type { CustomizePlace } from "../../web/customize-route";
import type { SkillOrigin, SkillSort, CustomizeOffers } from "./customize-list";
import type { HostInfo } from "../../../shared/host";
import type { ClientPolicy } from "../../../shared/client-policy";

/** What customizeMenus needs from CustomizePage.tsx. */
export interface CustomizeMenusKit {
  app: AppController | undefined;
  connectorStatus: ConnectorStatus;
  connectorType: ConnectorType;
  creator: CustomizeSkill | undefined;
  host: HostInfo;
  loadSkills: () => Promise<void>;
  marketplaceList: boolean;
  offers: CustomizeOffers;
  onConfirmRemove: (skill: CustomizeSkill, remove: () => Promise<void>) => void;
  onError: (error: unknown) => void;
  onOpenSettings: (tab: string) => void;
  onRouteChange: ((place: CustomizePlace) => void) | undefined;
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
  resetEntries: PageMenuEntry[];
  route: CustomizePlace | undefined;
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
  setSort: React.Dispatch<React.SetStateAction<SkillSort>>;
  setSubmissionsPage: React.Dispatch<
    React.SetStateAction<"list" | "plugin" | "mcp" | undefined>
  >;
  sort: SkillSort;
  tab: Tab;
  upload: () => void;
  view: View;
}

export function customizeMenus(kit: CustomizeMenusKit) {
  const {
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
  } = kit;
  const menuEntries = (current: OpenMenu): PageMenuEntry[] => {
    if (current.kind === "add")
      return tab === "skills"
        ? [
            ...(offers.upload
              ? [
                  {
                    label: "Upload skill",
                    icon: Upload,
                    onSelect: upload,
                  },
                ]
              : []),
            {
              label: "Create a skill",
              icon: Pencil,
              onSelect: () => setCreating(true),
            },
            // R-1110/R-1516: "Create with Claude" (chat bubble), disabled
            // where Claudex cannot run the skill-creator in a Code chat.
            creator && app && offers.createWithCode
              ? {
                  label: "Create with Claudex",
                  icon: MessageCircleMore,
                  onSelect: () => {
                    app.newChat("code");
                    app.setText(
                      "Use the skill-creator skill to help me create a new skill. Ask me what it should do, then save it under $CODEX_HOME/skills.",
                    );
                  },
                }
              : {
                  label: "Create with Claudex",
                  icon: MessageCircleMore,
                  disabled: true,
                  title: notAvailable,
                  onSelect: () => {},
                },
            // The original's screen recording; not in Claudex.
            {
              label: "Record your screen",
              icon: Video,
              disabled: true,
              title: notAvailable,
              onSelect: () => {},
            },
          ]
        : tab === "plugins"
          ? [
              ...pluginAddMenu({
                connector:
                  host.capabilities.localMcp ||
                  host.capabilities.customConnectors
                    ? [
                        {
                          label: "Add plugin from MCP URL",
                          icon: Link,
                          disabled: !policy.localMcpEditing,
                          title: policy.localMcpEditing
                            ? undefined
                            : mcpEditingRefusal({
                                pending: policy.pending ? true : undefined,
                              }),
                          onSelect: () => setPluginAction("connector"),
                        },
                      ]
                    : [],
                onUpload: () => {
                  if (!owner.current()) return;
                  if (route && onRouteChange)
                    onRouteChange({
                      section: "plugins",
                      view,
                      pluginPage: "upload",
                    });
                  else setPluginAction("upload");
                },
                onManageMarketplaces: plugins.catalog?.marketplaces.length
                  ? () => setPluginAction("manage")
                  : undefined,
                onAddMarketplace: () => setAddingMarketplace(true),
                onCreate: () => setPluginAction("create"),
                onCreateWithClaudex: app
                  ? () => {
                      app.newChat("code");
                      app.setText("Help me create a new Claudex Code plugin");
                    }
                  : undefined,
              }),
              { separator: true },
              {
                label: "Submit a plugin",
                icon: Send,
                onSelect: () => setSubmissionsPage("plugin"),
              },
              {
                label: "View submissions",
                onSelect: () => setSubmissionsPage("list"),
              },
            ]
          : [
              {
                label: "Submit an MCP connector",
                icon: Send,
                onSelect: () => setSubmissionsPage("mcp"),
              },
              {
                label: "View submissions",
                onSelect: () => setSubmissionsPage("list"),
              },
              {
                label: "Add in Developer settings",
                icon: SquareTerminal,
                onSelect: () => onOpenSettings("developer"),
              },
            ];
    if (current.kind === "filter" && marketplaceList)
      return [
        { heading: "Marketplace" },
        {
          label: "All marketplaces",
          checked: !pluginMarketplace,
          onSelect: () => setPluginMarketplace(undefined),
        },
        ...(plugins.catalog?.marketplaces ?? []).map((item) => {
          const count =
            plugins.catalog?.plugins.filter(
              (plugin) => plugin.marketplace === item.name,
            ).length ?? 0;
          return {
            label:
              item.name === "claude-plugins-official"
                ? t("Community marketplace")
                : (item.title ?? item.name),
            value: count.toLocaleString(),
            valueLabel: formatText(
              count === 1 ? "1 plugin" : "{count} plugins",
              { count: count.toLocaleString() },
            ),
            checked: pluginMarketplace === item.name,
            onSelect: () => setPluginMarketplace(item.name),
          };
        }),
        { separator: true },
        { heading: "Category" },
        {
          label: "All categories",
          checked: !pluginCategory,
          onSelect: () => setPluginCategory(undefined),
        },
        ...pluginCategoriesOf(plugins.catalog?.plugins ?? []).map((item) => ({
          label: item.label,
          checked: pluginCategory === item.id,
          onSelect: () => setPluginCategory(item.id),
        })),
      ];
    if (current.kind === "sort" && view === "discover" && marketplaceList)
      return [
        { heading: "Sort by" },
        ...(Object.keys(discoverSortLabels) as PluginSort[]).map((value) => ({
          label: discoverSortLabels[value],
          checked: value === "name",
          disabled: value !== "name",
          title:
            value !== "name"
              ? t(
                  "This marketplace does not provide install counts or addition dates.",
                )
              : undefined,
          onSelect: () => {},
        })),
      ];
    if (current.kind === "sort")
      return [
        { heading: "Sort by" },
        ...(["edited", "name"] as const).map((value) => ({
          label: value === "edited" ? "Last edited" : "Name",
          checked: sort === value,
          onSelect: () => setSort(value),
        })),
        ...resetEntries,
      ];
    if (current.kind === "filter")
      return tab === "skills"
        ? [
            { heading: "Created by" },
            ...(
              [
                ["all", "All"],
                ["you", "You"],
                ["organization", "Your organization"],
                ["builtin", "Built in"],
              ] as const
            ).map(([value, label]) => ({
              label,
              checked: origin === value,
              onSelect: () => setOrigin(value),
            })),
            ...resetEntries,
          ]
        : [
            { heading: "Type" },
            ...(
              [
                ["all", "All"],
                ["local", offers.programLabel],
                ["remote", "Remote"],
              ] as const
            ).map(([value, label]) => ({
              label,
              checked: connectorType === value,
              onSelect: () => setConnectorType(value),
            })),
            { separator: true },
            { heading: "Status" },
            ...(
              [
                ["all", "All"],
                ["connected", "Connected"],
                ["disconnected", "Not connected"],
              ] as const
            ).map(([value, label]) => ({
              label,
              checked: connectorStatus === value,
              onSelect: () => setConnectorStatus(value),
            })),
          ];
    const skill = current.skill!;
    return [
      {
        label: skill.enabled ? "Turn off" : "Turn on",
        icon: Power,
        onSelect: () => void setEnabled(skill, !skill.enabled),
      },
      // Live order: Rename (the person's own skills), then Duplicate, then
      // Show in folder.
      ...(skill.own
        ? [
            {
              label: "Rename",
              icon: Pencil,
              onSelect: () => setNaming({ kind: "rename", skill }),
            },
          ]
        : []),
      {
        label: "Duplicate",
        icon: Copy,
        onSelect: () => setNaming({ kind: "duplicate", skill }),
      },
      ...(offers.reveal
        ? [
            {
              label: "Show in folder",
              icon: FolderOpen,
              onSelect: () =>
                void window.desktop.revealSkill(skill.path).catch(onError),
            },
          ]
        : []),
      ...(skill.own
        ? [
            { separator: true as const },
            {
              label: "Remove",
              icon: Trash2,
              danger: true,
              onSelect: () =>
                onConfirmRemove(skill, async () => {
                  await window.desktop.deleteSkill(skill.path);
                  await loadSkills();
                }),
            },
          ]
        : []),
    ];
  };
  return menuEntries;
}
