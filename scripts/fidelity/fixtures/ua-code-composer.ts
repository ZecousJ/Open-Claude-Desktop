/**
 * Code composer alignment (package UA). Without parameters the fixture has
 * no model catalog, as today's service: the Code model menu's Fast mode row
 * is greyed out with its reason. `fast=tier` adds a catalog whose Opus 5.5
 * has a fast tier ("Opus 5.5 Fast", `fastOf` in shared/fast-mode.ts), so the
 * row can be switched on; `fast=on` also selects that tier, which draws the
 * Fast tag after the model name in the menu and on the composer's button.
 */
import type { ModelCatalog } from "../../../shared/model-catalog-api";
import type { FastAwareCatalogItem } from "../../../shared/fast-mode";
import type { FixtureDomain } from "./index";

const fastId = "Opus 5.5 Fast";

const item = (
  id: string,
  sort: number,
  extra: Partial<FastAwareCatalogItem> = {},
): FastAwareCatalogItem => ({
  id,
  displayName: id,
  description: "",
  badges: [],
  sort,
  hidden: false,
  isDefault: sort === 0,
  usageHint: "",
  ...extra,
});

const catalog: ModelCatalog = {
  defaultModel: "Opus 5.5",
  items: [
    item("Opus 5.5", 0, { description: "Most capable for ambitious work" }),
    item("Fable 5.1", 1),
    item("Sonnet 5", 2, { description: "Best for everyday tasks" }),
    item("Haiku 4.5", 3, { description: "Fastest for quick answers" }),
    item("Opus 5", 4, { hidden: true }),
    // The fast tier sits under More models unless it is the current model.
    item(fastId, 5, { hidden: true, fastOf: "Opus 5.5" }),
  ],
};

export const uaCodeComposerFixture: FixtureDomain = {
  params: {
    fast: "tier: Opus 5.5 has a fast tier; on: the fast tier is selected",
  },
  bridge: ({ params, state }) => {
    const fast = params.get("fast");
    if (fast !== "tier" && fast !== "on") return {};
    const provider = state.settings.providers[0];
    if (provider && !provider.models.includes(fastId)) {
      provider.models = [...provider.models, fastId];
      if (fast === "on") provider.model = fastId;
    }
    return { modelCatalog: async () => catalog };
  },
};
