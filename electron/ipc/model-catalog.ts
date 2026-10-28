import type { ModelCatalog } from "../../shared/model-catalog-api";
import { refreshAccountState } from "./usage";
import type { AppContext, IpcHandle } from "../app/app-context";

/** The administrator's model catalog and the plan's models (package C2). */
export function registerModelCatalogHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  // The Claudex service's catalog, already met with the models the gateway
  // lists for this device's key; null for local accounts and older services
  // (menus then list the provider's models).
  handle("modelCatalog", (): ModelCatalog | null => {
    const catalog = (ctx.remote?.ready && ctx.remote.modelCatalog()) || null;
    return catalog ? { ...catalog, desktopVersion: ctx.appVersion } : null;
  });
  handle("refreshModels", async () => {
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
