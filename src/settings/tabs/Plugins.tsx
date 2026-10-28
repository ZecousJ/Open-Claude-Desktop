import { useTryPluginChat } from "../../plugins/try-plugin-chat";
import { Suspense, useContext, useRef, useState } from "react";
import { Link } from "../../ui/glyphs";
import type { PluginEntry } from "../../../shared/collections-api";
import { IconButton } from "../../ui/Controls";
import { AppIcon } from "../../ui/app-icon";
import { PageMenu, type PageMenuEntry } from "../../collections/PageMenu";
import { Segmented } from "../controls";
import { PluginsBody } from "../../plugins/PluginsBody";
import { AddMarketplaceDialog } from "../../plugins/AddMarketplaceDialog";
import { PluginDetailDialog } from "../../plugins/PluginDetailDialog";
import { pluginCategoriesOf } from "../../plugins/plugin-model";
import { usePlugins } from "../../plugins/usePlugins";
import { AppContext } from "../../app/AppContext";
import { pluginAddMenu } from "../../plugins/plugin-menu";
import type { TabProps } from "../context";
import "../desktop.css";
import "../directory/directory.css";
import "../../collections/customize/customize.css";
import "../../plugins/plugins-settings.css";
import { lazyPiece } from "../../ui/lazy-piece";
import { usePolicy } from "../../policy/PolicyContext";
import { useHost } from "../../host/HostContext";
import { mcpEditingRefusal } from "../../../shared/client-policy";
const PluginAddConnector = lazyPiece(
  () => import("../../plugins/PluginAddConnector"),
  "PluginAddConnector",
);
const PluginUploadDialog = lazyPiece(
  () => import("../../plugins/PluginUploadDialog"),
  "PluginUploadDialog",
);
const ManageMarketplacesDialog = lazyPiece(
  () => import("../../plugins/ManageMarketplacesDialog"),
  "ManageMarketplacesDialog",
);
const CreatePluginDialog = lazyPiece(
  () => import("../../plugins/CreatePluginDialog"),
  "CreatePluginDialog",
);

export function mcpPluginMenuEntry(
  available: boolean,
  editing: boolean,
  pending: boolean | undefined,
  onAdd: () => void,
): PageMenuEntry[] {
  return available
    ? [
        {
          label: "Add plugin from MCP URL",
          icon: Link,
          disabled: !editing,
          title: editing
            ? undefined
            : mcpEditingRefusal({ pending: pending ? true : undefined }),
          onSelect: onAdd,
        },
      ]
    : [];
}

/** Rows Settings search finds on this page. */
export { pluginsLabels as searchLabels } from "./desktop-labels";

type View = "yours" | "discover";

/**
 * Plugins. Yours lists the plugins installed in the agent runtime; Discover
 * lists what the account's marketplaces offer, with search and a marketplace or
 * category filter, and Add marketplace syncs a GitHub repository or Git address
 * (Anthropic's is one click).
 */
export function PluginsTab({
  initialView = "yours",
  onError = () => {},
}: Partial<TabProps> & {
  /** The view shown first; Yours, as in the original, by default. */
  initialView?: View;
}) {
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const [marketplace, setMarketplace] = useState<string>();
  const [detail, setDetail] = useState<PluginEntry>();
  const [menu, setMenu] = useState<"add" | "filter" | "sort">();
  const [sort, setSort] = useState<"name">("name");
  const [adding, setAdding] = useState(false);
  const [addingConnector, setAddingConnector] = useState(false);
  const [pluginAction, setPluginAction] = useState<
    "upload" | "manage" | "create"
  >();
  const app = useContext(AppContext);
  const tryPlugin = useTryPluginChat({
    onError,
    routeKey: JSON.stringify({
      view,
      query,
      category,
      marketplace,
      detail: detail?.id,
    }),
  });
  const policy = usePolicy();
  const host = useHost();
  const customConnectors =
    host.capabilities.localMcp || host.capabilities.customConnectors;
  const plugins = usePlugins();
  const addButton = useRef<HTMLButtonElement>(null);
  const filterButton = useRef<HTMLSpanElement>(null);
  const sortButton = useRef<HTMLSpanElement>(null);
  const toggle = (name: "add" | "filter" | "sort") =>
    setMenu(menu === name ? undefined : name);
  const list = plugins.catalog?.plugins ?? [];
  const menus: Record<"add" | "filter" | "sort", PageMenuEntry[]> = {
    add: pluginAddMenu({
      connector: mcpPluginMenuEntry(
        customConnectors,
        policy.localMcpEditing,
        policy.pending,
        () => setAddingConnector(true),
      ),
      onUpload: () => setPluginAction("upload"),
      onManageMarketplaces: plugins.catalog?.marketplaces.length
        ? () => setPluginAction("manage")
        : undefined,
      onAddMarketplace: () => setAdding(true),
      onCreate: () => setPluginAction("create"),
      onCreateWithClaudex: app
        ? () => {
            app.newChat("code");
            app.setText("Help me create a new Claudex Code plugin");
          }
        : undefined,
    }),
    filter: [
      { heading: "Marketplace" },
      {
        label: "All marketplaces",
        checked: !marketplace,
        onSelect: () => setMarketplace(undefined),
      },
      ...(plugins.catalog?.marketplaces ?? []).map((entry) => ({
        label: entry.title ?? entry.name,
        checked: marketplace === entry.name,
        onSelect: () => setMarketplace(entry.name),
      })),
      { separator: true },
      { heading: "Category" },
      {
        label: "All categories",
        checked: !category,
        onSelect: () => setCategory(undefined),
      },
      ...pluginCategoriesOf(list).map((entry) => ({
        label: entry.label,
        checked: category === entry.id,
        onSelect: () => setCategory(entry.id),
      })),
    ],
    sort: [
      { heading: "Sort by" },
      ...["Most installed", "Recently added"].map((label) => ({
        label,
        checked: false,
        disabled: true,
        title:
          "This marketplace does not provide install counts or addition dates.",
        onSelect: () => {},
      })),
      {
        label: "Name",
        checked: sort === "name",
        onSelect: () => setSort("name"),
      },
    ],
  };
  return (
    <div className="settings-list-page desktop-list directory-plugins plugins-settings">
      <header className="plugins-settings-header">
        <div className="plugins-settings-identity">
          <h2>Plugins</h2>
          <Segmented<View>
            label="Plugins"
            value={view}
            options={[
              { value: "yours", label: "Yours" },
              { value: "discover", label: "Discover" },
            ]}
            onChange={(next) => {
              setView(next);
              setMenu(undefined);
            }}
          />
        </div>
        <div className="plugins-settings-tools">
          <label className="settings-page-search">
            <AppIcon name="Search" size={16} />
            <input
              type="search"
              placeholder="Search"
              aria-label="Search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (event.target.value) setView("discover");
              }}
            />
          </label>
          {view === "discover" && (
            <div className="settings-page-tools">
              <span ref={filterButton} className="settings-page-anchor">
                <IconButton
                  label="Filter"
                  className={`settings-page-tool ${marketplace || category ? "filtered" : ""}`}
                  menu
                  tooltip={false}
                  expanded={menu === "filter"}
                  onClick={() => toggle("filter")}
                >
                  <AppIcon name="Filter" size={20} />
                </IconButton>
              </span>
              <span ref={sortButton} className="settings-page-anchor">
                <IconButton
                  label="Sort"
                  className="settings-page-tool"
                  menu
                  tooltip={false}
                  expanded={menu === "sort"}
                  onClick={() => toggle("sort")}
                >
                  <AppIcon name="Sort" size={20} />
                </IconButton>
              </span>
            </div>
          )}
          <button
            ref={addButton}
            type="button"
            className="desktop-add-button"
            aria-label="Add plugin"
            aria-haspopup="menu"
            aria-expanded={menu === "add"}
            onClick={() => toggle("add")}
          >
            <AppIcon name="Add" size={20} />
            Add
            <AppIcon name="CaretDown" size={16} />
          </button>
        </div>
      </header>
      {menu && (
        <PageMenu
          label={
            menu === "add" ? "Add plugin" : menu === "sort" ? "Sort" : "Filter"
          }
          width={240}
          anchor={
            menu === "add"
              ? addButton
              : menu === "sort"
                ? sortButton
                : filterButton
          }
          onClose={() => setMenu(undefined)}
          entries={menus[menu]}
        />
      )}
      <PluginsBody
        view={view}
        filter={{ query, category, marketplace, sort }}
        plugins={plugins}
        onUsePlugin={tryPlugin}
        onOpen={setDetail}
        onAddMarketplace={() => setAdding(true)}
        onDiscover={() => setView("discover")}
        onError={onError}
      />
      {adding && (
        <AddMarketplaceDialog
          plugins={plugins}
          onClose={() => setAdding(false)}
          onAdded={() => setView("discover")}
        />
      )}
      {addingConnector && (
        <Suspense fallback={null}>
          <PluginAddConnector
            onError={onError}
            onClose={() => setAddingConnector(false)}
            onAdded={() => {
              setAddingConnector(false);
              void plugins.reload();
            }}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        {pluginAction === "upload" && (
          <PluginUploadDialog
            onClose={() => setPluginAction(undefined)}
            onUploaded={() => {
              void plugins.reload();
              setView("yours");
            }}
          />
        )}
        {pluginAction === "manage" && (
          <ManageMarketplacesDialog
            plugins={plugins}
            onClose={() => setPluginAction(undefined)}
            onAdd={() => {
              setPluginAction(undefined);
              setAdding(true);
            }}
            onError={onError}
          />
        )}
        {pluginAction === "create" && (
          <CreatePluginDialog
            onClose={() => setPluginAction(undefined)}
            onCreated={() => {
              void plugins.reload();
              setView("yours");
            }}
          />
        )}
      </Suspense>
      {detail && (
        <PluginDetailDialog
          plugin={detail}
          plugins={plugins}
          onUsePlugin={tryPlugin}
          onClose={() => setDetail(undefined)}
          onError={onError}
        />
      )}
    </div>
  );
}
