import { Suspense } from "react";
import { t } from "../i18n";
import { lazyPiece, preloadPiece } from "../ui/lazy-piece";
import { Pictogram } from "../ui/Pictogram";
import { PluginDiscover } from "./PluginDiscover";
import { pluginCuration } from "./plugin-curation";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import type { PluginEntry } from "../../shared/collections-api";
import { PluginsIllustration } from "../settings/directory/icons";
import {
  filterPlugins,
  pluginEmptyMessage,
  type PluginFilter,
} from "./plugin-model";
import { usePluginErrorReporter, type PluginsState } from "./usePlugins";
import "../settings/directory/directory.css";
import "../collections/customize/customize.css";
import "../collections/customize/customize-directory.css";
import "./plugins.css";
import "./plugin-lifecycle.css";
import "../collections/customize/customize-yours.css";
import { PluginRows, PluginCards } from "./PluginRows";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
const Marketplaces = lazyPiece(() => import("./Marketplaces"));
const MarketplaceError = lazyPiece(
  () => import("./Marketplaces"),
  "MarketplaceError",
);
export const preloadMarketplaces = () =>
  Promise.all([preloadPiece(Marketplaces), preloadPiece(MarketplaceError)]);

/**
 * What a marketplace-less account sees in Discover: plugins come from
 * marketplaces, and the first one to offer is Anthropic's.
 */
function NoMarketplace({
  plugins,
  onAdd,
  onError,
}: {
  plugins: PluginsState;
  onAdd: () => void;
  onError: (error: unknown) => void;
}) {
  const reportPluginError = usePluginErrorReporter(onError);

  return (
    <section className="customize-callout plugin-callout">
      <div>
        <strong>Add a plugin marketplace</strong>
        <p>
          Plugins bundle skills, connectors and hooks. Browse community
          marketplaces or sync your own from a repository.
        </p>
        <span className="plugin-callout-actions">
          <button
            type="button"
            disabled={plugins.busy !== undefined}
            onClick={() => void plugins.addOfficial().catch(reportPluginError)}
          >
            {plugins.busy === "marketplace"
              ? "Adding…"
              : "Add community marketplace"}
          </button>
          <button type="button" onClick={onAdd}>
            Add from a repository
          </button>
        </span>
      </div>
      <PluginsIllustration />
    </section>
  );
}

/**
 * The plugins on Settings → Plugins and Customize → Plugins. Yours lists
 * what is installed; Discover lists what the account's marketplaces offer,
 * filtered, with the marketplaces themselves below.
 */
export function PluginsBody({
  view,
  noun = "plugins",
  directory,
  customize = false,
  filter,
  plugins,
  onOpen,
  onAddMarketplace,
  onDiscover,
  onError,
  onTry,
  onUsePlugin,
}: {
  view: "yours" | "discover";
  /** Skills → Discover lists the same marketplace plugins as skills. */
  noun?: "plugins" | "skills";
  /** The Claudex directory, whose curation picks Discover's blocks. */
  directory?: ApprovedDirectoryEntry[];
  /** Customize has a separately observed empty card; Settings keeps its own shell. */
  customize?: boolean;
  filter: PluginFilter;
  plugins: PluginsState;
  onOpen: (entry: PluginEntry) => void;
  onAddMarketplace: () => void;
  onDiscover: () => void;
  onError: (error: unknown) => void;
  /** Offered by the parent when it can open a chat with this plugin. */
  onTry?: (entry: PluginEntry) => void;
  onUsePlugin?: (id: string, current?: () => boolean) => void;
}) {
  const { catalog, failure } = plugins;
  const searching = Boolean(
    filter.query?.trim() || filter.category || filter.marketplace,
  );
  if (!catalog)
    return (
      <>
        {failure ? (
          <div className="plugin-note plugin-failure">
            <Suspense fallback={failure}>
              <MarketplaceError error={failure} />
            </Suspense>{" "}
            <button type="button" onClick={() => void plugins.reload()}>
              Try again
            </button>
          </div>
        ) : (
          <DiscoverSkeleton label={t("Loading plugins")} />
        )}
      </>
    );
  const all = catalog.plugins;
  const found = filterPlugins(all, filter);
  const problems = catalog.loadErrors.length > 0 && (
    <Suspense fallback={null}>
      <MarketplaceError error={catalog.loadErrors.join(" ")} />
    </Suspense>
  );
  if (view === "yours" && !searching) {
    const installed = all.filter((plugin) => plugin.installed);
    return installed.length ? (
      <>
        {problems}
        <PluginRows
          entries={installed}
          plugins={plugins}
          onOpen={onOpen}
          onError={onError}
          onTry={onTry}
          onUsePlugin={onUsePlugin}
          compactActions={customize}
        />
      </>
    ) : (
      <section className="customize-callout customize-yours-callout">
        <div>
          <h3>Add your first plugins</h3>
          <p>
            Give Claudex role-level expertise with plugins. Add them from
            Discover, or create your own.
          </p>
          <button
            type="button"
            data-setting="Discover plugins"
            onClick={onDiscover}
          >
            Discover plugins
          </button>
        </div>
        <Pictogram name="ObjectPuzzle" size={64} />
      </section>
    );
  }
  if (!catalog.marketplaces.length)
    return (
      <>
        {problems}
        <NoMarketplace
          plugins={plugins}
          onAdd={onAddMarketplace}
          onError={onError}
        />
      </>
    );
  const shown = view === "yours" ? found.filter((p) => p.installed) : found;
  const selectedMarketplace =
    catalog.marketplaces.find(
      (marketplace) => marketplace.name === filter.marketplace,
    ) ??
    (catalog.marketplaces.length === 1 ? catalog.marketplaces[0] : undefined);
  const emptyMessage = pluginEmptyMessage(
    filter,
    selectedMarketplace?.name === "personal" ||
      selectedMarketplace?.source === "manual" ||
      selectedMarketplace?.name === "local-desktop-app-uploads",
    selectedMarketplace?.source === "manual" ||
      selectedMarketplace?.name === "local-desktop-app-uploads",
  );
  // Both entry points use the actual catalog. Ranked/curated discovery blocks
  // require backend metadata that this bridge does not currently publish.
  if (view === "discover" && !searching)
    return (
      <>
        {problems}
        <PluginDiscover
          entries={shown}
          noun={noun}
          curation={pluginCuration(catalog.plugins, directory)}
          emptyMessage={emptyMessage}
          busy={plugins.busy}
          onOpen={onOpen}
          onInstall={plugins.install}
          onError={onError}
          renderRows={(entries) => (
            <PluginCards
              entries={entries}
              plugins={plugins}
              onOpen={onOpen}
              onError={onError}
              onTry={onTry}
              onUsePlugin={onUsePlugin}
            />
          )}
          footer={
            !customize && (
              <Suspense fallback={null}>
                <Marketplaces
                  plugins={plugins}
                  onAdd={onAddMarketplace}
                  onError={onError}
                />
              </Suspense>
            )
          }
        />
      </>
    );
  return (
    <>
      {problems}
      {shown.length ? (
        view === "discover" ? (
          <PluginCards
            entries={shown}
            plugins={plugins}
            onOpen={onOpen}
            onError={onError}
            onTry={onTry}
            onUsePlugin={onUsePlugin}
          />
        ) : (
          <PluginRows
            entries={shown}
            plugins={plugins}
            onOpen={onOpen}
            onError={onError}
            onTry={onTry}
            onUsePlugin={onUsePlugin}
            compactActions={customize}
          />
        )
      ) : (
        <p className="plugin-empty-state">{emptyMessage}</p>
      )}
      {view === "discover" && !searching && (
        <Suspense fallback={null}>
          <Marketplaces
            plugins={plugins}
            onAdd={onAddMarketplace}
            onError={onError}
          />
        </Suspense>
      )}
    </>
  );
}

/** The names' widths. */
const skeletonNames = [112, 144, 96, 128, 160, 112, 128, 96];

/**
 * Customize's Discover while its catalog loads: no words, the cards' shapes.
 */
function DiscoverSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup className="customize-discover-skeleton" label={label}>
      <Skeleton width={128} height={20} />
      <ul className="customize-cards customize-catalogue-cards">
        {skeletonNames.map((width, index) => (
          <li key={index}>
            <span className="customize-card">
              <Skeleton
                width={48}
                height={48}
                className="customize-card-tile-sk"
              />
              <span className="customize-card-text">
                <Skeleton width={width} height={20} />
                <Skeleton width="92%" height={15} />
                <Skeleton width="60%" height={15} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </SkeletonGroup>
  );
}
