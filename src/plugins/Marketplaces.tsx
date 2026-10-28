import { useRef, useState } from "react";
import { Ellipsis } from "../ui/glyphs";
import type { PluginMarketplace } from "../../shared/collections-api";
import { marketplaceFailure } from "../../shared/marketplace-status";
import { currentLocale, formatText, t } from "../i18n";
import { openSettingsLink } from "../settings/navigation";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import {
  usePluginOwner,
  usePluginErrorReporter,
  PluginOperationRetired,
  type PluginsState,
} from "./usePlugins";
import "./marketplaces.css";

export function MarketplaceError({
  error,
  source,
}: {
  error: string;
  source?: string;
}) {
  const heading = marketplaceFailure(error);
  let hostname = "";
  try {
    hostname = new URL(source ?? "").hostname;
  } catch {}
  const message =
    heading === "Network access required"
      ? t(
          "Browsing plugins requires network access to reach plugin marketplaces. Enable network egress in <link>capabilities settings</link> to browse and install plugins.",
        )
      : heading === "Marketplace unreachable" && hostname
        ? formatText(
            "Network access to {hostname} is blocked by egress settings. Plugins from this marketplace won’t receive updates. Update <link>capabilities settings</link>.",
            { hostname },
          )
        : undefined;
  const parts = message?.split(/<link>|<\/link>/);
  return (
    <div className="marketplace-error" role="alert">
      <strong>{heading}</strong>
      {heading === "Git is required" ? (
        <p>Browsing plugins requires Git to clone marketplace repositories.</p>
      ) : parts ? (
        <p>
          {parts[0]}
          <button
            type="button"
            className="marketplace-settings-link"
            onClick={() => openSettingsLink("capabilities")}
          >
            {parts[1]}
          </button>
          {parts[2]}
        </p>
      ) : (
        <p>{error}</p>
      )}
    </div>
  );
}

function MarketplaceRow({
  marketplace,
  plugins,
  onRemove,
  onError,
  management,
}: {
  marketplace: PluginMarketplace;
  management: boolean;
  plugins: PluginsState;
  onRemove: () => void;
  onError: (error: unknown) => void;
}) {
  const { current: ownsRow } = usePluginOwner();
  const reportPluginError = usePluginErrorReporter(onError);
  const [menu, setMenu] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  let github = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
    marketplace.source ?? "",
  );
  try {
    github ||= new URL(marketplace.source ?? "").hostname === "github.com";
  } catch {}
  const entries: MenuEntry[] = [
    {
      label: "Check for updates",
      onSelect: () =>
        void plugins
          .upgradeMarketplaces(marketplace.name)
          .catch(reportPluginError),
    },
    ...(github
      ? [
          {
            label: "Sync automatically",
            description: "Re-syncs on GitHub changes",
            switched: marketplace.autoSync ?? false,
            keepOpen: true,
            onSelect: () =>
              void plugins
                .setAutoSync(marketplace.name, !marketplace.autoSync)
                .catch(reportPluginError),
          },
        ]
      : []),
    { separator: true },
    {
      label: "Remove marketplace",
      danger: true,
      onSelect: () => {
        if (ownsRow()) onRemove();
      },
    },
  ];
  return (
    <li>
      <div className="marketplace-summary">
        <strong>
          {marketplace.name === "claude-plugins-official"
            ? t("Community marketplace")
            : (marketplace.title ?? marketplace.name)}
        </strong>
        {!management && (
          <small>
            {marketplace.plugins === 1
              ? "1 plugin"
              : formatText("{count} plugins", { count: marketplace.plugins })}
            {marketplace.name === "claude-plugins-official"
              ? ` · ${t("Community")}`
              : ""}
          </small>
        )}
        {management ? (
          <small data-no-translate>
            {marketplace.source || marketplace.path}
          </small>
        ) : (
          marketplace.source &&
          marketplace.name !== "claude-plugins-official" && (
            <small>{marketplace.source}</small>
          )
        )}
        {marketplace.lastUpdated !== undefined && (
          <small>
            {formatText("Last updated: {when}", {
              when: new Intl.DateTimeFormat(currentLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(marketplace.lastUpdated),
            })}
          </small>
        )}
        {marketplace.syncedCommit && (
          <small>
            {t("Synced commit: {sha}")
              .split("{sha}")
              .map((part, index) =>
                index === 0 ? (
                  part
                ) : (
                  <span key={index}>
                    <span className="marketplace-commit">
                      {marketplace.syncedCommit!.slice(0, 7)}
                    </span>
                    {part}
                  </span>
                ),
              )}
          </small>
        )}
        {plugins.busy === marketplace.name || plugins.busy === "marketplace" ? (
          <small aria-live="polite">Syncing…</small>
        ) : (
          marketplace.syncError && (
            <MarketplaceError
              error={marketplace.syncError}
              source={marketplace.source}
            />
          )
        )}
      </div>
      <button
        type="button"
        ref={anchor}
        aria-label={formatText("More actions for {name}", {
          name:
            marketplace.name === "claude-plugins-official"
              ? t("Community marketplace")
              : (marketplace.title ?? marketplace.name),
        })}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={plugins.busy !== undefined}
        onClick={() => {
          const rect = anchor.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: innerWidth - rect.right, top: rect.bottom + 4 },
          );
        }}
      >
        <Ellipsis size={16} />
      </button>
      {menu && (
        <Menu
          label="Marketplace options"
          size="regular"
          width="max-content"
          position={menu}
          anchors={[anchor]}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </li>
  );
}

// Options and uninstall confirmation.
export default function Marketplaces({
  plugins,
  onAdd,
  onError,
  management = false,
}: {
  plugins: PluginsState;
  onAdd: () => void;
  onError: (error: unknown) => void;
  management?: boolean;
}) {
  const { scope, current: ownsMarketplaces } = usePluginOwner();
  const reportPluginError = usePluginErrorReporter(onError);
  const [removing, setRemoving] = useState<{
    scope: typeof scope;
    name: string;
  }>();
  const list = plugins.catalog?.marketplaces ?? [];
  const installed =
    plugins.catalog?.plugins.filter(
      (entry) => entry.marketplace === removing?.name && entry.installed,
    ) ?? [];
  if (!list.length) return null;
  return (
    <section
      className={`plugin-marketplaces${management ? " plugin-marketplaces-management" : ""}`}
    >
      {!management && <h2>Marketplaces</h2>}
      <ul role="list">
        {list.map((marketplace) => (
          <MarketplaceRow
            key={marketplace.name}
            marketplace={marketplace}
            plugins={plugins}
            management={management}
            onRemove={() => {
              if (ownsMarketplaces())
                setRemoving({ scope, name: marketplace.name });
            }}
            onError={onError}
          />
        ))}
      </ul>
      {!management && (
        <div className="plugin-marketplace-actions">
          <button
            type="button"
            disabled={plugins.busy !== undefined}
            onClick={() =>
              void plugins.upgradeMarketplaces().catch(reportPluginError)
            }
          >
            {plugins.busy === "marketplace" ? "Syncing…" : "Update all"}
          </button>
          <button type="button" onClick={onAdd}>
            Add marketplace
          </button>
        </div>
      )}
      {removing?.scope === scope && (
        <ConfirmationDialog
          confirmation={{
            title: "Remove marketplace?",
            confirm: "Remove",
            body: installed.length
              ? installed.length === 1
                ? "This will also uninstall 1 plugin from this marketplace:"
                : formatText(
                    "This will also uninstall {count} plugins from this marketplace:",
                    { count: installed.length },
                  )
              : "This will remove the marketplace from your list.",
            action: async () => {
              if (!ownsMarketplaces()) throw new PluginOperationRetired();
              await plugins.removeMarketplace(removing.name);
              if (!ownsMarketplaces()) throw new PluginOperationRetired();
            },
          }}
          onClose={() => {
            if (ownsMarketplaces()) setRemoving(undefined);
          }}
          onError={reportPluginError}
        >
          {installed.length > 0 && (
            <ul className="marketplace-removal-plugins">
              {installed.map((entry) => (
                <li key={entry.id}>{entry.title}</li>
              ))}
            </ul>
          )}
        </ConfirmationDialog>
      )}
    </section>
  );
}
