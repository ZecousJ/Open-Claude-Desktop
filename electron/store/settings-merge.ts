import { isDeepStrictEqual } from "node:util";

/**
 * The settings a save from the window stands for.
 *
 * The window sends its whole copy, which can be older than what the main
 * process changed meanwhile (the MCP configuration file, skill switches, a
 * policy change). A field the window left as it was last sent (`base`) keeps
 * the stored value; a field it changed takes the window's value; fields only
 * the main process changes (`owned`) always keep the stored value.
 */
export function mergeSavedSettings<T extends object>(
  stored: T,
  incoming: T,
  base: T | undefined,
  owned: readonly (keyof T)[],
): T {
  const result = { ...incoming } as Record<keyof T, unknown>;
  const keys = new Set([
    ...Object.keys(stored),
    ...Object.keys(incoming),
  ]) as Set<keyof T>;
  for (const key of keys) {
    const keep =
      owned.includes(key) ||
      (base !== undefined && isDeepStrictEqual(incoming[key], base[key]));
    if (!keep) continue;
    if (key in stored) result[key] = stored[key];
    else delete result[key];
  }
  return result as T;
}
