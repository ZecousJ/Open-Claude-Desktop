import { formatText, listSeparator, tc } from "../i18n";
import { Plus } from "../ui/glyphs";
import type { PluginEntry } from "../../shared/collections-api";
import { showToast } from "../ui/toast-store";
import {
  CatalogueCards,
  type CatalogueCard,
} from "../collections/customize/CustomizeDirectory";
import { directoryGlyph } from "../settings/directory/icons";
import { categoryLabel, pluginByline, pluginIcon } from "./plugin-model";
import {
  usePluginOwner,
  usePluginErrorReporter,
  type PluginsState,
} from "./usePlugins";
import "../settings/directory/directory.css";
import "../collections/customize/customize.css";
import "../collections/customize/customize-directory.css";
import { DirectoryReviewBadge } from "../settings/directory/DirectoryReview";
import "./plugins.css";
import "./plugin-lifecycle.css";
import "../collections/customize/customize-yours.css";

/** Rows of plugins, each with its Add (or Added) button. */
export function PluginRows({
  entries,
  plugins,
  onOpen,
  onError,
  onTry,
  onUsePlugin,
  compactActions = false,
}: {
  entries: PluginEntry[];
  plugins: PluginsState;
  onOpen: (entry: PluginEntry) => void;
  onError: (error: unknown) => void;
  onTry?: (entry: PluginEntry) => void;
  onUsePlugin?: (id: string, current?: () => boolean) => void;
  compactActions?: boolean;
}) {
  const { current: ownsRows } = usePluginOwner();
  const reportPluginError = usePluginErrorReporter(onError);

  return (
    <ul className="customize-directory-rows plugin-rows">
      {entries.map((entry) => {
        const Glyph = directoryGlyph(pluginIcon(entry.category));
        return (
          <li key={entry.id}>
            <button
              type="button"
              aria-label={formatText("View {name}", { name: entry.title })}
              onClick={() => {
                if (ownsRows()) onOpen(entry);
              }}
            >
              <span className="customize-row-tile" aria-hidden="true">
                <Glyph size={18} strokeWidth={1.4} />
              </span>
              <span className="customize-directory-row-text">
                <span>
                  <strong>{entry.title}</strong>
                  <DirectoryReviewBadge review="community" kind="plugin" />
                  {entry.category && <em>{categoryLabel(entry.category)}</em>}
                </span>
                <small>
                  {pluginByline(entry)}
                  {entry.description ? ` · ${entry.description}` : ""}
                </small>
              </span>
            </button>
            <span className="plugin-row-action">
              {(onUsePlugin || onTry) && !entry.installed && (
                <button
                  type="button"
                  className={compactActions ? "plugin-row-try" : undefined}
                  aria-label={formatText("Add {name} and try it in chat", {
                    name: entry.title,
                  })}
                  disabled={!entry.installable || plugins.busy !== undefined}
                  onClick={() =>
                    void plugins
                      .install(entry.id)
                      .then((services) => {
                        if (!ownsRows()) return;
                        if (services.length) {
                          showToast(
                            formatText(
                              "Added. It also uses {services}, which need signing in before Claudex can use them.",
                              { services: services.join(listSeparator()) },
                            ),
                          );
                          return;
                        }
                        if (onUsePlugin) onUsePlugin(entry.id, ownsRows);
                        else onTry?.(entry);
                      })
                      .catch(reportPluginError)
                  }
                >
                  Try it
                </button>
              )}
              {entry.installed ? (
                <button type="button" disabled>
                  {tc("state", "Added")}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={formatText("Add {name}", { name: entry.title })}
                  className={compactActions ? "plugin-row-add" : undefined}
                  disabled={!entry.installable || plugins.busy !== undefined}
                  title={
                    entry.installable
                      ? undefined
                      : "This plugin can't be installed."
                  }
                  onClick={() =>
                    void plugins.install(entry.id).catch(reportPluginError)
                  }
                >
                  {plugins.busy === entry.id ? (
                    "…"
                  ) : compactActions ? (
                    <Plus size={20} aria-hidden="true" />
                  ) : (
                    "Add"
                  )}
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Discover's plugins as the live directory cards, for the real marketplace
 * entries: + installs, Try installs and starts a chat with it.
 */
export function PluginCards({
  entries,
  plugins,
  onOpen,
  onError,
  onTry,
  onUsePlugin,
}: {
  entries: PluginEntry[];
  plugins: PluginsState;
  onOpen: (entry: PluginEntry) => void;
  onError: (error: unknown) => void;
  onTry?: (entry: PluginEntry) => void;
  onUsePlugin?: (id: string, current?: () => boolean) => void;
}) {
  const { current: ownsRows } = usePluginOwner();
  const reportPluginError = usePluginErrorReporter(onError);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const cards: CatalogueCard[] = entries.map((entry) => ({
    id: entry.id,
    name: entry.title,
    description: entry.description ?? "",
    byline: pluginByline(entry),
    icon: pluginIcon(entry.category),
  }));
  const installable = (card: CatalogueCard) =>
    byId.get(card.id)?.installable === true;
  return (
    <CatalogueCards
      entries={cards}
      installed={
        new Set(entries.filter((entry) => entry.installed).map((e) => e.id))
      }
      busy={plugins.busy}
      blockedReason="This plugin can't be installed."
      canAdd={installable}
      canAddAndTry={(card) =>
        Boolean(onUsePlugin || onTry) && installable(card)
      }
      onOpen={(card) => {
        const entry = byId.get(card.id);
        if (entry && ownsRows()) onOpen(entry);
      }}
      onAdd={(card) => void plugins.install(card.id).catch(reportPluginError)}
      onAddAndTry={(card) => {
        const entry = byId.get(card.id);
        if (!entry) return;
        void plugins
          .install(entry.id)
          .then((services) => {
            if (!ownsRows()) return;
            if (services.length) {
              showToast(
                formatText(
                  "Added. It also uses {services}, which need signing in before Claudex can use them.",
                  { services: services.join(listSeparator()) },
                ),
              );
              return;
            }
            if (onUsePlugin) onUsePlugin(entry.id, ownsRows);
            else onTry?.(entry);
          })
          .catch(reportPluginError);
      }}
    />
  );
}
