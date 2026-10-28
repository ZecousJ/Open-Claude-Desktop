import { preference, type SettingsPreferences } from "./settings-extras";

/**
 * Tool access for one conversation: "on" loads connector tools when needed
 * (Codex's tool search), "off" sends them all from the start. Unset follows
 * Settings → Capabilities → Tool access mode.
 *
 * Codex turns its tool search off per model (the model catalog's
 * `supports_search_tool`), and only for the catalog it started with, so each
 * model has a twin whose slug carries `preloadedModelSuffix`: a turn that
 * preloads its tools names the twin, and the gateway restores the real model
 * before the request leaves (electron/engine/gateway.ts).
 */
export type ToolSearchMode = "on" | "off";

export const preloadedModelSuffix = "~tools-loaded";

export function effectiveToolSearch(
  conversation: { toolSearchMode?: ToolSearchMode } | undefined,
  settings: SettingsPreferences,
): ToolSearchMode {
  return (
    conversation?.toolSearchMode ??
    (preference(settings, "toolAccessMode") === "loaded" ? "off" : "on")
  );
}

/** The model slug Codex is given for a turn with this tool access. */
export function codexModelSlug(model: string, mode: ToolSearchMode) {
  return mode === "off" ? `${model}${preloadedModelSuffix}` : model;
}

/** The real model a Codex request names. */
export function upstreamModel(slug: string) {
  return slug.endsWith(preloadedModelSuffix)
    ? slug.slice(0, -preloadedModelSuffix.length)
    : slug;
}
