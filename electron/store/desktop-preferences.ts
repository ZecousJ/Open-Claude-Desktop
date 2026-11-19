import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { desktopPreferenceFields } from "./settings-preferences";

const fields = desktopPreferenceFields(process.platform);
const schema = z.object({
  quickAccessShortcut: fields.quickAccessShortcut,
  legacyQuickEntryEnabled: fields.legacyQuickEntryEnabled,
  quickEntryShortcut: fields.quickEntryShortcut,
  quickEntryDictationShortcut: fields.quickEntryDictationShortcut,
  dictationShortcut: fields.dictationShortcut,
  menuBar: fields.menuBar,
  keepAwake: fields.keepAwake,
  keepAwakeWhileCoding: fields.keepAwakeWhileCoding,
  keepAwakeOnBattery: fields.keepAwakeOnBattery,
  notificationLevels: fields.notificationLevels,
  notificationSound: fields.notificationSound,
  drawAttention: fields.drawAttention,
});
export type DesktopPreferences = z.infer<typeof schema>;

export function desktopPreferences(settings: DesktopPreferences): DesktopPreferences {
  return {
    quickAccessShortcut: settings.quickAccessShortcut,
    legacyQuickEntryEnabled: settings.legacyQuickEntryEnabled,
    quickEntryShortcut: settings.quickEntryShortcut,
    quickEntryDictationShortcut: settings.quickEntryDictationShortcut,
    dictationShortcut: settings.dictationShortcut,
    menuBar: settings.menuBar,
    keepAwake: settings.keepAwake,
    keepAwakeWhileCoding: settings.keepAwakeWhileCoding,
    keepAwakeOnBattery: settings.keepAwakeOnBattery,
    notificationLevels: settings.notificationLevels,
    notificationSound: settings.notificationSound,
    drawAttention: settings.drawAttention,
  };
}

function filename(root: string) {
  return path.join(root, "desktop-keybindings.json");
}

export function readDesktopPreferences(root: string): DesktopPreferences | undefined {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(filename(root), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeDesktopPreferences(root: string, preferences: DesktopPreferences) {
  const file = filename(root);
  fs.writeFileSync(file + ".tmp", JSON.stringify(preferences), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
