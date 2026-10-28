import { currentLocale, formatText, listSeparator, useT } from "../i18n";
import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { createPortal } from "react-dom";
import { Check, Ellipsis } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import { AppContext } from "../app/AppContext";
import type { PluginEntry } from "../../shared/collections-api";
import { copyName, pluginSlug } from "../../shared/duplicate-name";
import { duplicateFailureText, PluginRenameDialog } from "./PluginRenameDialog";
import { validPluginDetails } from "./plugin-detail-model";
import { useHostCapability } from "../host/HostContext";
import { showToast } from "../ui/toast-store";
import { NameCopyDialog } from "../collections/customize/NameCopyDialog";
import { SettingsModal } from "../settings/controls";
import { directoryGlyph } from "../settings/directory/icons";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import {
  categoryLabel,
  officialMarketplace,
  pluginByline,
  pluginIcon,
} from "./plugin-model";
import {
  usePluginOwner,
  usePluginErrorReporter,
  isPluginOperationRetired,
  PluginOperationRetired,
  type PluginsState,
} from "./usePlugins";
import "../settings/directory/directory.css";
import "../collections/customize/customize.css";
import "../collections/customize/customize-directory.css";
import { CommunityExplainer } from "../settings/directory/DirectoryReview";
import "./plugins.css";
import "./plugin-lifecycle.css";
import "../collections/customize/customize-yours.css";

const PluginRemoveDialog = lazyPiece(
  () => import("./PluginRemoveDialog"),
  "PluginRemoveDialog",
);

/**
 * A plugin's page: what it is, what it brings (read from the plugin's own
 * files), and Add or Remove.
 */
export function PluginDetailDialog({
  plugin,
  plugins,
  onClose,
  onError,
  onTry,
  onUsePlugin,
}: {
  plugin: PluginEntry;
  plugins: PluginsState;
  onClose: () => void;
  onError: (error: unknown) => void;
  onTry?: (entry: PluginEntry) => void;
  onUsePlugin?: (id: string, current?: () => boolean) => void;
}) {
  const reportPluginError = usePluginErrorReporter(onError);

  const t = useT();
  const app = useContext(AppContext);
  const { scope, bridge, current: ownsDetailOwner } = usePluginOwner();
  const localFolders = useHostCapability("localFolders");
  const [selection, setSelection] = useState({
    scope,
    inputId: plugin.id,
    id: plugin.id,
  });
  const id =
    selection.scope === scope && selection.inputId === plugin.id
      ? selection.id
      : plugin.id;
  const setId = (next: string) =>
    setSelection({ scope, inputId: plugin.id, id: next });
  const route = useMemo(
    () => ({
      page: app?.page,
      activeId: app?.activeId,
      draftSession: app?.draftSession,
      mode: app?.mode,
      settingsOpen: app?.settingsOpen,
      url: typeof window === "undefined" ? undefined : window.location?.href,
    }),
    [
      scope,
      app?.page,
      app?.activeId,
      app?.draftSession,
      app?.mode,
      app?.settingsOpen,
      typeof window === "undefined" ? undefined : window.location?.href,
    ],
  );
  const lease = useMemo(() => ({ scope, id, route }), [scope, id, route]);
  const activeLease = useRef<typeof lease | undefined>(lease);
  activeLease.current = lease;
  useLayoutEffect(() => {
    activeLease.current = lease;
    return () => {
      if (activeLease.current === lease) activeLease.current = undefined;
    };
  }, [lease]);
  const ownsDetail = useCallback(() => {
    const actor = app?.currentController?.current;
    return (
      ownsDetailOwner() &&
      activeLease.current === lease &&
      window.location?.href === route.url &&
      (!app?.currentController ||
        Boolean(
          actor &&
          actor.page === route.page &&
          actor.activeId === route.activeId &&
          actor.draftSession === route.draftSession &&
          actor.mode === route.mode &&
          actor.settingsOpen === route.settingsOpen,
        ))
    );
  }, [lease, ownsDetailOwner, app?.currentController, route]);
  const reportDetailError = (error: unknown) => {
    if (ownsDetail()) reportPluginError(error);
  };
  type Details =
    Awaited<ReturnType<typeof window.desktop.readPlugin>> | "failed";
  const [reading, setReading] = useState<{
    lease: typeof lease;
    value?: Details;
  }>();
  const details = reading?.lease === lease ? reading.value : undefined;
  const [attempt, setAttempt] = useState(0);
  const [needsSignIn, setNeedsSignIn] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuPosition>();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    if (!ownsDetail() || !bridge) return;
    setReading({ lease });
    void Promise.resolve()
      .then(() => {
        if (!live || !ownsDetail()) return undefined;
        return bridge.readPlugin(id);
      })
      .then((value) => {
        if (!live || !ownsDetail()) return;
        if (!validPluginDetails(value))
          throw new Error("Invalid plugin details");
        setReading({ lease, value });
      })
      .catch(() => {
        if (live && ownsDetail()) setReading({ lease, value: "failed" });
      });
    return () => {
      live = false;
    };
  }, [lease, bridge, ownsDetail, attempt]);
  // The list changes after Add and Remove; follow it.
  const current =
    plugins.catalog?.plugins.find((item) => item.id === id) ?? plugin;
  const actionKnown = current.id === id;
  const Glyph = directoryGlyph(pluginIcon(current.category));
  const working = plugins.busy === current.id;
  const [duplicating, setDuplicating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  useLayoutEffect(() => {
    setNeedsSignIn([]);
    setMenu(undefined);
    setDuplicating(false);
    setRenaming(false);
    setRemoving(false);
  }, [lease]);
  useLayoutEffect(() => {
    if (!current.installed) setRemoving(false);
  }, [current.installed]);
  // The copy needs the plugin's files and a home folder of this person's own.
  const duplicateBlocked = !localFolders
    ? "Duplicating plugins needs the Claudex desktop app."
    : current.source !== "local"
      ? "This plugin’s files aren’t on this computer, so it can’t be duplicated."
      : undefined;
  const read = details && details !== "failed" ? details : undefined;
  const updateAvailable = Boolean(
    current.installed &&
    current.installedVersion &&
    current.availableVersion &&
    current.installedVersion !== current.availableVersion,
  );
  // Share needs a plugin sharing service, which git and local marketplaces
  // don't have; the live page shows it only for shareable plugins.
  const actions: MenuEntry[] = actionKnown
    ? [
        ...(current.personal && localFolders && plugins.rename
          ? [
              {
                label: "Rename",
                disabled: plugins.busy !== undefined,
                onSelect: () => {
                  if (ownsDetail() && plugins.busy === undefined)
                    setRenaming(true);
                },
              },
            ]
          : []),
        ...(current.installed && plugins.duplicate
          ? [
              {
                label: "Duplicate",
                disabled:
                  Boolean(duplicateBlocked) || plugins.busy !== undefined,
                title: duplicateBlocked,
                onSelect: () => {
                  if (
                    ownsDetail() &&
                    !duplicateBlocked &&
                    plugins.busy === undefined
                  )
                    setDuplicating(true);
                },
              },
            ]
          : []),
        ...(current.installed
          ? [
              ...((current.personal && localFolders && plugins.rename) ||
              plugins.duplicate
                ? [{ separator: true } as const]
                : []),
              {
                label: working ? "Removing…" : "Remove",
                danger: true,
                disabled: plugins.busy !== undefined,
                onSelect: () => {
                  if (
                    ownsDetail() &&
                    current.installed &&
                    plugins.busy === undefined
                  )
                    setRemoving(true);
                },
              },
            ]
          : []),
      ]
    : [];
  return (
    <SettingsModal
      title={current.title}
      onClose={() => {
        if (ownsDetail()) onClose();
      }}
    >
      <div className="directory-detail plugin-detail">
        <div className="directory-detail-head">
          <span
            className="settings-list-tile directory-tile"
            aria-hidden="true"
          >
            <Glyph size={17} strokeWidth={1.5} />
          </span>
          <div>
            <span className="directory-detail-name">
              <small>{pluginByline(current)}</small>
            </span>
            <small>
              {current.category ? categoryLabel(current.category) : "Plugin"}
              {" · "}
              {current.marketplace === officialMarketplace.name
                ? "Community marketplace"
                : current.marketplace}
            </small>
          </div>
        </div>
        <p>
          {read?.description ||
            current.description ||
            (details === undefined
              ? "Loading…"
              : details === "failed"
                ? ""
                : "No description.")}
        </p>
        {details === "failed" && (
          <div className="plugin-detail-read-failure" role="alert">
            <span>{t("Couldn’t load this plugin.")}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (ownsDetail()) setAttempt((value) => value + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}
        {read && (
          <ul className="plugin-contents">
            {read.skills.length > 0 && (
              <li>
                <strong>Skills</strong>
                <span>{read.skills.map((item) => item.name).join(", ")}</span>
              </li>
            )}
            {read.mcpServers.length > 0 && (
              <li>
                <strong>Connectors</strong>
                <span>
                  {read.mcpServers.map((item) => item.name).join(", ")}
                </span>
              </li>
            )}
            {read.apps.length > 0 && (
              <li>
                <strong>Apps</strong>
                <span>{read.apps.map((item) => item.name).join(", ")}</span>
              </li>
            )}
            {read.hooks > 0 && (
              <li>
                <strong>Hooks</strong>
                <span>
                  {formatText(
                    read.hooks === 1
                      ? "{count} hook that runs commands"
                      : "{count} hooks that run commands",
                    { count: read.hooks.toLocaleString(currentLocale()) },
                  )}
                </span>
              </li>
            )}
          </ul>
        )}
        {current.website && (
          <button
            type="button"
            className="directory-link"
            onClick={() =>
              ownsDetail() &&
              void bridge!
                .openExternal(current.website!)
                .catch(reportDetailError)
            }
          >
            Website
          </button>
        )}
        {!current.installed && (
          <CommunityExplainer kind="plugin" onError={onError} />
        )}
        {needsSignIn.length > 0 && (
          <p className="directory-unavailable" role="note">
            <span data-no-translate>
              {formatText(
                "Added. It also uses {services}, which need signing in before Claudex can use them.",
                { services: needsSignIn.join(listSeparator()) },
              )}
            </span>
          </p>
        )}
        <div className="button-row plugin-detail-actions">
          {/* Added: the neutral badge with a check once the plugin is set up. */}
          {actionKnown && current.installed && (
            <span className="connector-badge directory-review-badge plugin-detail-added">
              <Check size={14} aria-hidden="true" />
              Added
            </span>
          )}
          {/* Update: when the installed version and the marketplace's are both
             known; installing again updates it. */}
          {actionKnown &&
            current.installed &&
            current.installedVersion &&
            current.availableVersion && (
              <button
                type="button"
                className={updateAvailable ? "primary" : "secondary"}
                disabled={!updateAvailable || plugins.busy !== undefined}
                title={
                  updateAvailable
                    ? formatText("Update to {version}", {
                        version: current.availableVersion,
                      })
                    : t("On latest version")
                }
                onClick={() => {
                  if (
                    !ownsDetail() ||
                    !updateAvailable ||
                    plugins.busy !== undefined
                  )
                    return;
                  void plugins
                    .install(current.id)
                    .then((services) => {
                      if (ownsDetail()) setNeedsSignIn(services);
                    })
                    .catch(reportDetailError);
                }}
              >
                {working ? t("Updating…") : t("Update")}
              </button>
            )}
          {(onUsePlugin || onTry) && actionKnown && current.installed && (
            <button
              type="button"
              className={updateAvailable ? "secondary" : "primary"}
              disabled={!current.enabled || plugins.busy !== undefined}
              title={
                !current.enabled ? "Turn this plugin on to try it" : undefined
              }
              onClick={() => {
                if (
                  !ownsDetail() ||
                  !current.enabled ||
                  !current.installed ||
                  plugins.busy !== undefined
                )
                  return;
                if (onUsePlugin) onUsePlugin(current.id, ownsDetail);
                else onTry?.(current);
              }}
            >
              <AppIcon name="Chat" size={16} /> Try in chat
            </button>
          )}
          {actions.length > 0 && (
            <button
              type="button"
              ref={menuAnchor}
              className="secondary plugin-detail-more"
              disabled={removing || renaming || duplicating}
              aria-label={formatText("More actions for {name}", {
                name: current.title,
              })}
              aria-haspopup="menu"
              aria-expanded={Boolean(menu)}
              onClick={() => {
                if (!ownsDetail()) return;
                const rect = menuAnchor.current!.getBoundingClientRect();
                setMenu(
                  menu
                    ? undefined
                    : { right: innerWidth - rect.right, top: rect.bottom + 4 },
                );
              }}
            >
              <Ellipsis size={20} />
            </button>
          )}
          {actionKnown && !current.installed && (
            <button
              type="button"
              className="primary"
              disabled={!current.installable || plugins.busy !== undefined}
              onClick={() => {
                if (
                  !ownsDetail() ||
                  !current.installable ||
                  plugins.busy !== undefined
                )
                  return;
                void plugins
                  .install(current.id)
                  .then((services) => {
                    if (ownsDetail()) setNeedsSignIn(services);
                  })
                  .catch(reportDetailError);
              }}
            >
              {working ? "Adding…" : "Add"}
            </button>
          )}
        </div>
      </div>
      {menu && (
        <Menu
          label={formatText("More actions for {name}", { name: current.title })}
          size="regular"
          width="max-content"
          position={menu}
          anchors={[menuAnchor]}
          entries={actions}
          onClose={() => setMenu(undefined)}
        />
      )}
      {removing &&
        actionKnown &&
        current.installed &&
        createPortal(
          <Suspense fallback={null}>
            <PluginRemoveDialog
              id={current.id}
              remove={plugins.uninstall}
              isCurrent={ownsDetail}
              onClose={() => {
                if (ownsDetail()) setRemoving(false);
              }}
            />
          </Suspense>,
          document.body,
        )}
      {duplicating &&
        plugins.duplicate &&
        createPortal(
          <NameCopyDialog
            title="Duplicate plugin"
            isCurrent={ownsDetail}
            action="Duplicate"
            fieldLabel="New plugin name"
            initialName={copyName(
              current.name,
              current.title !== current.name ? current.title : undefined,
              t("{name} copy"),
            )}
            slug={pluginSlug}
            savedAs="Saved as "
            note="The copy is added to your personal plugins."
            sameName={current.name}
            sameMessage="Choose a name different from the original."
            onSubmit={async (typed, name) => {
              try {
                if (!ownsDetail()) throw new PluginOperationRetired();
                await plugins.duplicate!(current.id, {
                  name,
                  // The typed text is the copy's display name unless it is
                  // the plain name itself (live: displayName when one was
                  // shown or the typed text differs from the saved name).
                  ...(current.title !== current.name || typed !== name
                    ? { displayName: typed }
                    : {}),
                });
              } catch (error) {
                if (!ownsDetail() || isPluginOperationRetired(error)) return;
                throw new Error(duplicateFailureText(error));
              }
              if (!ownsDetail()) return;
              showToast(
                formatText("Duplicated as {pluginName}", {
                  pluginName: typed,
                }),
              );
            }}
            onClose={() => {
              if (ownsDetail()) setDuplicating(false);
            }}
          />,
          document.body,
        )}
      {renaming &&
        plugins.rename &&
        createPortal(
          <PluginRenameDialog
            plugin={current}
            isCurrent={ownsDetail}
            rename={async (target, copy) => {
              if (!ownsDetail()) throw new PluginOperationRetired();
              const result = await plugins.rename!(target, copy);
              if (!ownsDetail()) throw new PluginOperationRetired();
              return result;
            }}
            onRenamed={(id) => {
              if (ownsDetail()) setId(id);
            }}
            onClose={() => {
              if (ownsDetail()) setRenaming(false);
            }}
          />,
          document.body,
        )}
    </SettingsModal>
  );
}
