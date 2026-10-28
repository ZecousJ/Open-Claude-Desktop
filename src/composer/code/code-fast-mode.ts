import type { ModelCatalog } from "../../../shared/model-catalog-api";
import type { FastAwareCatalogItem } from "../../../shared/fast-mode";

export type FastModeState =
  | {
      available: true;
      /** The current model is the fast tier. */
      on: boolean;
      /** The model id the toggle switches to. */
      target: string;
    }
  | { available: false; on: false; reason: string };

/** Shown on the disabled row when the catalog names no fast tier. */
export const fastUnavailableReason = "Not available for this model";

const items = (catalog: ModelCatalog | null | undefined) =>
  (catalog?.items ?? []) as FastAwareCatalogItem[];

/** Whether the catalog marks this model as another model's fast tier. */
export function isFastTier(
  catalog: ModelCatalog | null | undefined,
  model: string,
) {
  return Boolean(items(catalog).find((i) => i.id === model)?.fastOf);
}

/**
 * The Fast mode row of the Code model menu. It turns on only when the catalog
 * has a fast tier of the current model (or the current model is one); otherwise
 * it stays disabled with the reason.
 */
export function fastModeState(
  catalog: ModelCatalog | null | undefined,
  model: string,
): FastModeState {
  const list = items(catalog);
  const current = list.find((i) => i.id === model);
  if (current?.fastOf && list.some((i) => i.id === current.fastOf))
    return { available: true, on: true, target: current.fastOf };
  const fast = list.find((i) => i.fastOf === model);
  if (fast) return { available: true, on: false, target: fast.id };
  return { available: false, on: false, reason: fastUnavailableReason };
}

/**
 * Whether any model has a fast tier: the shortcut list shows ⌥⌘F only then.
 */
export function catalogHasFastTier(catalog: ModelCatalog | null | undefined) {
  const list = items(catalog);
  return list.some(
    (item) => item.fastOf && list.some((other) => other.id === item.fastOf),
  );
}
