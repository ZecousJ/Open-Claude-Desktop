import { validAccelerator } from "../../shared/accelerator";
import {
  preferenceDefaults,
  type SettingsPreferences,
} from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";

/** Accelerators Quick access offers; anything else is refused. */
export function shortcutChoices(platform: NodeJS.Platform) {
  return platform === "darwin"
    ? ["Option+Space", "Command+Shift+Space", "Control+Option+Space"]
    : ["Control+Alt+Space", "Control+Shift+Space"];
}

/**
 * The preference fields spread into the main process's settings schema:
 * `shared/settings-extras-schema.ts` plus this platform's checks.
 */
export function desktopPreferenceFields(platform: NodeJS.Platform) {
  return {
    ...preferenceFields,
    quickEntryShortcut: preferenceFields.quickEntryShortcut.refine(
      (value) =>
        value === undefined ||
        value === "" ||
        value === "off" ||
        value === "double-tap-option" ||
        validAccelerator(value),
      "Choose a shortcut with a modifier key.",
    ),
    quickAccessShortcut: preferenceFields.quickAccessShortcut.refine(
      (value) =>
        value === undefined ||
        value === "" ||
        shortcutChoices(platform).includes(value) ||
        validAccelerator(value),
      "Choose a shortcut with a modifier key.",
    ),
  };
}

const keys = Object.keys(preferenceDefaults).concat(
  "workType",
) as (keyof SettingsPreferences)[];

/** The preferences as the renderer sees them. */
export function publicPreferences(
  settings: SettingsPreferences,
): SettingsPreferences {
  const result: Record<string, unknown> = {};
  for (const key of keys)
    if (settings[key] !== undefined) result[key] = settings[key];
  return result as SettingsPreferences;
}

/** None of these restart the agent runtime: they are read when used. */
export function withoutPreferences<T extends object>(settings: T): T {
  const copy = { ...settings } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}
