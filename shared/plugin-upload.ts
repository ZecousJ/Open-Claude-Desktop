export const pluginArchiveLimit = 200 * 1024 * 1024;
export const pluginBatchLimit = 20;
export const pluginArchiveTypes = ".zip,.plugin";
export const pluginArchiveRule =
  "Only .zip or .plugin files under 200 MB can be uploaded.";
export const pluginManifestRule =
  "The archive must contain a .claude-plugin/plugin.json manifest, or a top-level SKILL.md that declares the plugin’s components";
export const pluginTrustWarning =
  "Make sure you trust a plugin before installing or using it. Uploaded plugins are not controlled by Claudex, and Claudex cannot verify that they will work as intended. See each plugin’s homepage for more information.";

export function acceptsPluginArchive(file: { name: string; size: number }) {
  return /\.(zip|plugin)$/i.test(file.name) && file.size <= pluginArchiveLimit;
}

export type PluginUploadCommand =
  | { action: "begin"; name: string }
  | { action: "append"; id: string; data: string }
  | { action: "finish"; id: string; overwrite?: boolean }
  | { action: "cancel"; id: string };

export interface PluginUploadResult {
  id: string;
  pluginId?: string;
  conflict?: string;
}
