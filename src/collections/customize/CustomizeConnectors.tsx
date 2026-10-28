import { Suspense, useContext, useEffect, useState } from "react";
import { AppContext } from "../../app/AppContext";
import { lazyPiece } from "../../ui/lazy-piece";
import { Button } from "../../settings/controls";
import {
  ConnectorsTab,
  type ConnectorBrowseModel,
} from "../../settings/tabs/Connectors";
import { ConnectorRows } from "../../settings/directory/ConnectorRows";
import { connectorCategories } from "../../settings/directory/connector-detail-model";
import {
  connectorShelves,
  connectorFilterTitle,
} from "../../settings/tabs/ConnectorDirectory";
import {
  findConnectors,
  defaultConnectorFilter,
  featuredConnectorMembers,
  type ConnectorFilter,
} from "../../../shared/connectors-catalogue";
import type { Settings } from "../../../shared/types";
import { formatText } from "../../i18n";
import {
  connectorCategory,
  connectorFilterAvailability,
  type ConnectorFilterAvailability,
  type ConnectorDirectoryType,
} from "../../settings/directory/connector-categories";
import { ArrowRight } from "../../ui/glyphs";
import { customizePath } from "../../web/customize-route";
import "./customize-connectors.css";

const ConnectorFeatured = lazyPiece(
  () => import("../../settings/directory/ConnectorFeatured"),
);

export function CustomizeConnectors({
  settings,
  view,
  connectorId,
  category,
  filterType,
  directoryScope,
  onOpenDirectory,
  onFilterAvailability,
  onOpenCategory,
  query = "",
  onOpen,
  onBack,
  onOpenSettings,
  onError,
}: {
  settings: Settings;
  view: "yours" | "discover";
  connectorId?: string;
  category?: string;
  filterType?: ConnectorDirectoryType;
  directoryScope?: boolean;
  onOpenDirectory?: (type: ConnectorDirectoryType) => void;
  onFilterAvailability?: (availability: ConnectorFilterAvailability) => void;
  onOpenCategory?: (category?: string) => void;
  query?: string;
  onOpen: (id: string) => void;
  onBack: () => void;
  onOpenSettings: (tab: string) => void;
  onError: (error: unknown) => void;
}) {
  const app = useContext(AppContext);
  return (
    <ConnectorsTab
      settings={settings}
      goTo={onOpenSettings}
      onError={onError}
      save={async (patch) => {
        try {
          if (app) await app.updatePreference(patch);
          else await window.desktop.saveSettings({ ...settings, ...patch });
          return true;
        } catch (error) {
          onError(error);
          return false;
        }
      }}
      customize={{
        view,
        detailId: connectorId,
        query,
        onOpen,
        onBack,
        onOpenCategory,
        renderBrowse: (model) => (
          <div className="connector-directory-seat">
            <ConnectorBrowse
              model={model}
              query={query}
              categoryId={category}
              filterType={filterType}
              directoryScope={directoryScope}
              onOpenDirectory={onOpenDirectory}
              onFilterAvailability={onFilterAvailability}
              onOpenCategory={onOpenCategory}
              remoteIcons={!settings.disableNonessentialServices}
            />
          </div>
        ),
      }}
    />
  );
}

function ConnectorBrowse({
  model,
  query,
  remoteIcons,
  categoryId,
  filterType,
  directoryScope,
  onOpenDirectory,
  onFilterAvailability,
  onOpenCategory,
}: {
  categoryId?: string;
  filterType?: ConnectorDirectoryType;
  directoryScope?: boolean;
  onOpenDirectory?: (type: ConnectorDirectoryType) => void;
  onFilterAvailability?: (availability: ConnectorFilterAvailability) => void;
  onOpenCategory?: (category?: string) => void;
  model: ConnectorBrowseModel;
  query: string;
  remoteIcons: boolean;
}) {
  const availability = connectorFilterAvailability(model.entries);
  useEffect(() => {
    onFilterAvailability?.(availability);
  }, [
    onFilterAvailability,
    availability.isTrending,
    availability.isNew,
    availability.inChatUi,
    availability.desktopExtension,
  ]);
  const [localCategory, setCategory] = useState<string>();
  const scopedCategory = connectorCategory(categoryId);
  const category = scopedCategory?.label ?? localCategory;
  const matchesCategory = (value: string) =>
    scopedCategory
      ? connectorCategory(value)?.id === scopedCategory.id
      : value === category;
  const [shelfType, setShelfType] = useState<ConnectorFilter["type"]>();
  // Top's published directory is separate from the installed/private shelf.
  // Its Show all destination must preserve that same inventory boundary.
  const directoryEntries =
    directoryScope && (filterType ?? "all") === "all"
      ? model.entries.filter((entry) => !entry.installed)
      : model.entries;
  const filtered = findConnectors(
    {
      ...defaultConnectorFilter,
      type: filterType ?? shelfType ?? "all",
      query,
    },
    directoryEntries,
  ).filter(
    (entry) => !category || connectorCategories(entry).some(matchesCategory),
  );
  const narrowed = !!query.trim() || !!category || shelfType !== undefined;
  const categories = [
    ...new Map(
      model.entries.flatMap(connectorCategories).map((value) => {
        const target = connectorCategory(value);
        return [
          target?.id ?? value,
          { value, label: target?.label ?? value },
        ] as const;
      }),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));
  const rows = (entries: ConnectorBrowseModel["entries"]) => (
    <ConnectorRows
      entries={entries}
      variant="discover"
      servers={model.servers}
      onOpen={model.onOpen}
      onConnect={model.onConnect}
      canConnect={(entry) =>
        !model.loading && !model.failed && model.canConnect(entry)
      }
      busy={model.busy}
      remoteIcons={remoteIcons}
    />
  );
  return (
    <div className="customize-connector-directory">
      {model.failed && (
        <p role="alert">
          Couldn’t load connectors{" "}
          <Button onClick={model.retry}>Try again</Button>
        </p>
      )}
      {model.loading && <p role="status">Loading connectors</p>}
      {scopedCategory || directoryScope ? (
        <section className="customize-connector-category-results">
          <h2 className="sr-only">Connectors</h2>
          {rows(filtered)}
          {!filtered.length && !model.loading && !model.failed && (
            <p role="status">No connectors match your filters</p>
          )}
        </section>
      ) : narrowed ? (
        <section className="customize-connector-shelf">
          <div className="customize-connector-shelf-head">
            <h2>
              {scopedCategory
                ? "Connectors"
                : (category ?? connectorFilterTitle(shelfType ?? "all"))}
            </h2>
            {(category || shelfType) && (
              <Button
                onClick={() => {
                  setCategory(undefined);
                  setShelfType(undefined);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
          {rows(filtered)}
        </section>
      ) : (
        <>
          {model.entries.some((entry) => entry.featured) && (
            <Suspense fallback={null}>
              <ConnectorFeatured
                entries={model.entries}
                onOpen={model.onOpen}
                variant="customize"
                remoteIcons={remoteIcons}
                featuredMembers={(entry) =>
                  featuredConnectorMembers(entry, model.entries)
                }
              />
            </Suspense>
          )}
          {connectorShelves(model.entries).map((shelf) => (
            <section className="customize-connector-shelf" key={shelf.type}>
              <div className="customize-connector-shelf-head">
                <h2>
                  {shelf.title}
                  <span>{shelf.entries.length}</span>
                </h2>
                {onOpenDirectory && shelf.type !== "custom" ? (
                  <a
                    className="settings-button"
                    href={customizePath({
                      section: "connectors",
                      view: "discover",
                      ...(shelf.type === "all"
                        ? { connectorScope: "all" }
                        : { connectorType: shelf.type }),
                    })}
                    aria-label={formatText("Show all {section}", {
                      section: shelf.title,
                    })}
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      onOpenDirectory(shelf.type as ConnectorDirectoryType);
                    }}
                  >
                    Show all
                    <ArrowRight size={12} aria-hidden="true" />
                  </a>
                ) : (
                  <button
                    type="button"
                    className="settings-button"
                    aria-label={formatText("Show all {section}", {
                      section: shelf.title,
                    })}
                    onClick={() => setShelfType(shelf.type)}
                  >
                    Show all
                    <ArrowRight size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
              {rows(shelf.entries.slice(0, shelf.type === "all" ? 12 : 6))}
            </section>
          ))}
          {!!categories.length && (
            <section className="customize-connector-shelf">
              <h2>Categories</h2>
              <div className="customize-connector-categories">
                {categories.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    onClick={() => {
                      const target = connectorCategory(item.value);
                      if (target && onOpenCategory) onOpenCategory(target.id);
                      else setCategory(item.value);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
