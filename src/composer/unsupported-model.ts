import type { Provider } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { catalogChoices } from "./model/code-model-choices";

export function unsupportedModel(
  providers: Provider[],
  providerId: string,
  model: string,
  catalog: ModelCatalog | null | undefined,
) {
  if (!providers.length || !model) return undefined;
  const { listed, more } = catalogChoices(providers, catalog);
  const offered = [...listed, ...more];
  if (
    offered.some(
      (choice) => choice.providerId === providerId && choice.name === model,
    )
  )
    return undefined;
  const fallback =
    offered.find((choice) => choice.name === catalog?.defaultModel) ??
    offered[0];
  return {
    fallback,
    hint: fallback
      ? "You can continue using {model} instead."
      : providers.find((provider) => provider.id === providerId)?.backend ===
          "sub2api"
        ? "Ask your admin to make another model available."
        : "Make another model available in your inference configuration.",
  };
}
