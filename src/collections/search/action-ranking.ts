import Fuse from "fuse.js";
import type { PaletteAction } from "./search-model";

export const actionGroups = [
  ["navigation", "Navigation"],
  ["chat", "Chat"],
  ["project", "Project"],
  ["settings", "Settings"],
  ["general", "General"],
] as const;

function truncateField(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value)) return value.map(truncateField);
  if (
    value &&
    typeof value === "object" &&
    "v" in value &&
    typeof value.v === "string"
  )
    return { ...value, v: value.v.slice(0, 2000) };
  return value;
}

/**
 * O16 /5966. Same Fuse 7.4.0 options, weighted description/hints and
 * primary-prefix priority. Equal scores stay stable.
 */
export function rankPaletteActions(
  actions: readonly PaletteAction[],
  query: string,
): PaletteAction[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...actions];
  if (needle.length > 50) return [];
  const fields = actions.map((action) => ({
    action,
    descriptionLower: action.title.toLowerCase(),
    hintsLower: action.searchHints?.map((hint) => hint.toLowerCase()) ?? [],
  }));
  return new Fuse(fields, {
    keys: [
      { name: "descriptionLower", weight: 0.7 },
      { name: "hintsLower", weight: 0.3 },
    ],
    threshold: 0.2,
    ignoreLocation: true,
    includeScore: true,
    includeMatches: true,
    minMatchCharLength: 1,
    shouldSort: true,
    getFn: (item, path) =>
      truncateField(Fuse.config.getFn(item, path)) as ReturnType<
        typeof Fuse.config.getFn
      >,
  })
    .search(needle)
    .map((result) => ({
      ...result,
      prefix:
        result.matches?.some(
          (match) =>
            match.key === "descriptionLower" &&
            match.indices.some(([start]) => start === 0),
        ) ?? false,
    }))
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) || (a.score ?? 0) - (b.score ?? 0),
    )
    .map(({ item }) => item.action);
}
