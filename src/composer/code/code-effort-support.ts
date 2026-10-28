import type { CodeEffort } from "../../../shared/types";
import type { ModelCatalog } from "../../../shared/model-catalog-api";
import { codeEffortLevels } from "../../../shared/code-effort";

/**
 * The Code effort levels the model takes, from the administrator's catalog
 * (`efforts`, already limited to the group's ceiling). Ultracode is the
 * highest level and needs Max. Without a catalog entry, or one that lists
 * no Code level, every level stays available.
 */
export function codeEffortsFor(
  catalog: ModelCatalog | null | undefined,
  model: string,
): readonly CodeEffort[] {
  const efforts = catalog?.items.find((item) => item.id === model)?.efforts;
  if (!efforts) return codeEffortLevels;
  const offered = codeEffortLevels.filter((level) =>
    level === "ultra"
      ? efforts.includes("max")
      : (efforts as readonly string[]).includes(level),
  );
  return offered.length ? offered : codeEffortLevels;
}

/** The supported stop closest to `index` (the lower one on a tie). */
export function nearestSupportedEffort(
  index: number,
  supported: readonly CodeEffort[],
) {
  let best = index;
  let distance = Infinity;
  codeEffortLevels.forEach((level, i) => {
    if (!supported.includes(level)) return;
    const d = Math.abs(i - index);
    if (d < distance) {
      best = i;
      distance = d;
    }
  });
  return best;
}

/**
 * The next supported stop from `index` in `direction` (+1 or −1) for the
 * arrow keys; the same stop when there is none that way.
 */
export function stepSupportedEffort(
  index: number,
  direction: 1 | -1,
  supported: readonly CodeEffort[],
) {
  for (
    let i = index + direction;
    i >= 0 && i < codeEffortLevels.length;
    i += direction
  )
    if (supported.includes(codeEffortLevels[i])) return i;
  return index;
}
