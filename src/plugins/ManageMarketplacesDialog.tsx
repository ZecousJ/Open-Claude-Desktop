import { SettingsModal } from "../settings/controls";
import Marketplaces from "./Marketplaces";
import { t } from "../i18n";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { usePluginOwner } from "./usePlugins";
import type { PluginsState } from "./usePlugins";

export function ManageMarketplacesDialog({
  plugins,
  onClose,
  onAdd,
  onError,
}: {
  plugins: PluginsState;
  onClose: () => void;
  onAdd: () => void;
  onError: (error: unknown) => void;
}) {
  const { current } = usePluginOwner();
  const close = () => {
    if (current()) onClose();
  };
  return (
    <SettingsModal title="Manage marketplaces" onClose={close}>
      <p className="marketplace-management-description">
        Marketplaces you’ve added. Removing one also uninstalls its plugins.
      </p>
      {!plugins.catalog ? (
        plugins.failure ? (
          <p role="alert">
            {plugins.failure}{" "}
            <button
              type="button"
              onClick={() => {
                if (current()) void plugins.reload();
              }}
            >
              Try again
            </button>
          </p>
        ) : (
          <SkeletonGroup label={t("Loading")}>
            <Skeleton height={56} />
            <Skeleton height={56} />
          </SkeletonGroup>
        )
      ) : plugins.catalog.marketplaces.length ? (
        <Marketplaces
          plugins={plugins}
          onAdd={() => {
            if (current()) onAdd();
          }}
          onError={onError}
          management
        />
      ) : (
        <p className="marketplace-management-empty">
          No marketplaces added yet.
        </p>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </SettingsModal>
  );
}
