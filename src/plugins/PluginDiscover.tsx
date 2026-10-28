import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginEntry } from "../../shared/collections-api";
import { AppContext } from "../app/AppContext";
import { DataFeatureArt } from "../collections/customize/DataFeatureArt";
import { formatText, tc, useT } from "../i18n";
import {
  categoryLabel,
  pluginByline,
  pluginCategoriesOf,
} from "./plugin-model";
import { usePluginErrorReporter, usePluginOwner } from "./usePlugins";
import { emptyCuration, type PluginCuration } from "./plugin-curation";
import "./plugin-discover.css";

/** The supplied reference feature's identity, matched to an actual runtime
 * entry. A name/category coincidence never manufactures a Data directory. */
function dataFeature(entries: PluginEntry[]) {
  return entries.find(
    (entry) =>
      entry.id === "data@knowledge-work-plugins" &&
      entry.name === "data" &&
      entry.marketplace === "knowledge-work-plugins",
  );
}
/**
 * Source c6a2a31c4:8434–8580 renders authoritative home blocks and category
 * links. The blocks (featured, New, Most installed) come from the Claudex
 * directory's curation; without any, the marketplaces' plugins show as
 * Available, never as an invented New or Popular list.
 */
export function PluginDiscover({
  entries,
  noun = "plugins",
  curation = emptyCuration,
  busy,
  onOpen,
  onInstall,
  onError,
  renderRows,
  footer,
  emptyMessage,
}: {
  entries: PluginEntry[];
  /** Skills → Discover lists the same marketplace plugins as skills. */
  noun?: "plugins" | "skills";
  curation?: PluginCuration;
  busy?: string;
  onOpen(entry: PluginEntry): void;
  onInstall(id: string): Promise<string[]>;
  onError(error: unknown): void;
  renderRows(entries: PluginEntry[]): ReactNode;
  footer?: ReactNode;
  emptyMessage: string;
}) {
  const t = useT();
  const owner = usePluginOwner();
  const report = usePluginErrorReporter(onError);
  const app = useContext(AppContext);
  const origin =
    typeof window === "undefined" ? undefined : window.location?.origin;
  const current = () =>
    owner.current() &&
    window.location?.origin === origin &&
    (!app?.currentController ||
      app.currentController.current?.page === app.page);
  const resource = useMemo(() => ({}), [owner.scope, app?.page, origin]);
  const [selection, setSelection] = useState<{
    resource: object;
    category?: string;
    /** The block whose Show all is open. */
    all?: string;
  }>();
  const categories = pluginCategoriesOf(entries);
  const category =
    selection?.resource === resource &&
    categories.some((item) => item.id === selection.category)
      ? selection.category
      : undefined;
  const showAll = (block: string) =>
    selection?.resource === resource && selection.all === block;
  const shown = new Set(entries.map((entry) => entry.id));
  const curated = (list: PluginEntry[]) =>
    list.filter((entry) => shown.has(entry.id));
  const block = category ? undefined : curation.featured;
  const featured = category
    ? undefined
    : (curated(block?.plugins ?? [])[0] ?? dataFeature(entries));
  const heroTitle = block && featured ? block.title : featured?.title;
  const heroText =
    block && featured
      ? block.subtitle || featured.description
      : featured?.description;
  const newest = category ? [] : curated(curation.newest);
  const popular = category ? [] : curated(curation.popular);
  const rows = entries.filter(
    (entry) =>
      (!category || entry.category === category) && entry.id !== featured?.id,
  );
  const available =
    noun === "skills" ? "Available skills" : "Available plugins";
  const heading = category ? categoryLabel(category) : t(available);
  const section = (
    id: string,
    title: string,
    list: PluginEntry[],
    empty?: string,
  ) => (
    <section key={id} className="plugin-discovery-section" aria-label={title}>
      <div className="plugin-discovery-heading">
        <h3>{title}</h3>
        {list.length > 6 && (
          <button
            type="button"
            aria-label={`${t("Show all")}: ${title}`}
            aria-expanded={showAll(id)}
            onClick={() => {
              if (current())
                setSelection({
                  resource,
                  category,
                  all: showAll(id) ? undefined : id,
                });
            }}
          >
            {t(showAll(id) ? "Show less" : "Show all")}
          </button>
        )}
      </div>
      {list.length ? (
        renderRows(showAll(id) ? list : list.slice(0, 6))
      ) : (
        <p className="plugin-empty-state">{empty}</p>
      )}
    </section>
  );
  const featureLease = useMemo(() => ({}), [resource, featured?.id]);
  const latest = useRef(featureLease);
  latest.current = featureLease;
  const lock = useRef<object | undefined>(undefined);
  const [pending, setPending] = useState<object>();
  const featureBusy = pending === featureLease;
  const install = async () => {
    if (
      !featured ||
      !featured.installable ||
      featured.installed ||
      busy !== undefined ||
      lock.current === featureLease ||
      !current()
    )
      return;
    const lease = featureLease,
      id = featured.id,
      origin = window.location.origin;
    const ownsInstall = () =>
      current() &&
      latest.current === lease &&
      window.location.origin === origin;
    lock.current = lease;
    setPending(lease);
    try {
      await onInstall(id);
    } catch (error) {
      if (ownsInstall()) report(error);
    } finally {
      if (lock.current === lease) lock.current = undefined;
      if (ownsInstall()) setPending(undefined);
    }
  };
  return (
    <div className="plugin-discovery plugin-catalog-discover">
      {featured && (
        <section
          className={`customize-feature${noun === "plugins" ? " plugin" : ""} plugin-discovery-hero`}
          aria-label={heroTitle}
        >
          <div>
            <small data-no-translate>
              {block?.curator ?? pluginByline(featured)}
            </small>
            <h3>
              <button
                type="button"
                className="plugin-discovery-hero-title"
                aria-label={formatText("View {name}", { name: featured.title })}
                onClick={() => {
                  if (current()) onOpen(featured);
                }}
                data-no-translate
              >
                {heroTitle}
              </button>
            </h3>
            {heroText && <p data-no-translate>{heroText}</p>}
            <button
              type="button"
              className="plugin-discovery-hero-add"
              aria-label={formatText("Add {name}", { name: featured.title })}
              disabled={
                !featured.installable ||
                featured.installed ||
                busy !== undefined ||
                featureBusy
              }
              title={
                !featured.installable
                  ? t("This plugin can't be installed.")
                  : undefined
              }
              onClick={() => void install()}
            >
              {featured.installed
                ? tc("state", "Added")
                : t(featureBusy ? "Adding…" : "Add")}
            </button>
          </div>
          <span
            className="customize-feature-art plugin-discovery-hero-art"
            aria-hidden="true"
          >
            <DataFeatureArt />
          </span>
        </section>
      )}
      {newest.length > 0 &&
        section(
          "new",
          t(noun === "skills" ? "New skills" : "New plugins"),
          newest,
        )}
      {popular.length > 0 &&
        section(
          "popular",
          t(
            noun === "skills"
              ? "Most installed skills"
              : "Most installed plugins",
          ),
          popular,
        )}
      {(category || (!newest.length && !popular.length)) &&
        section(
          "available",
          heading,
          rows,
          t(
            category
              ? noun === "skills"
                ? "No skills match your filters"
                : "No plugins match your filters"
              : emptyMessage,
          ),
        )}
      {categories.length > 0 && (
        <section
          className="plugin-discovery-section"
          aria-label={t("Categories")}
        >
          <h3>{t("Categories")}</h3>
          <div className="plugin-discovery-categories">
            {categories.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={category === item.id}
                onClick={() => {
                  if (current())
                    setSelection({
                      resource,
                      category: category === item.id ? undefined : item.id,
                    });
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {footer}
    </div>
  );
}
