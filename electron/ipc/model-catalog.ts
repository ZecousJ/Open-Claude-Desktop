import { isConversationModel, type ModelCatalog } from "../../shared/model-catalog-api";
import { localEdition } from "../app/edition";
import { refreshLocalModels } from "../app/local-provider";
import { refreshAccountState } from "./usage";
import type { AppContext, IpcHandle } from "../app/app-context";

function localModelCatalog(ctx: AppContext): ModelCatalog | null {
  const settings = ctx.store.settings;
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId);
  if (!provider) return null;
  const ids = [...new Set([provider.model, ...provider.models])].filter(isConversationModel);
  return {
    desktopVersion: ctx.appVersion,
    defaultModel: ids.includes(provider.model) ? provider.model : ids[0] ?? null,
    items: ids.map((id, sort) => ({
      id,
      sort,
      displayName: id.replace(/^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra)$/, (_name, version, tier) =>
        `GPT-${version} ${tier[0].toUpperCase() + tier.slice(1)}`),
      description: "",
      badges: [],
      hidden: false,
      isDefault: id === provider.model,
      usageHint: "",
    })),
  };
}

/** The administrator's model catalog and the plan's models (package C2). */
export function registerModelCatalogHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  // The Claudex service's catalog, already met with the models the gateway
  // lists for this device's key; null for local accounts and older services
  // (menus then list the provider's models).
  handle("modelCatalog", (): ModelCatalog | null => {
    if (localEdition) return localModelCatalog(ctx);
    const catalog = (ctx.remote?.ready && ctx.remote.modelCatalog()) || null;
    return catalog ? { ...catalog, desktopVersion: ctx.appVersion } : null;
  });
  handle("refreshModels", async () => {
    if (localEdition) {
      await refreshLocalModels();
      return { settings: ctx.windowSettings(), reason: ctx.engine.unavailableReason };
    }
    const remote = ctx.remote;
    if (!remote) return null;
    // No usable model, or a refusal held from an empty balance: read the
    // account again (its balance may have changed since).
    if (remote.backend.problem || remote.backend.refusal)
      await refreshAccountState(ctx);
    return {
      settings: ctx.windowSettings(),
      reason: ctx.engine.unavailableReason,
    };
  });
}
