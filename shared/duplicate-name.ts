/**
 * Duplicate and Rename for skills and plugins. The dialog proposes a name for
 * the copy, shows the name it is saved as, and the main process refuses a name
 * that is taken with the live wording, so the dialog can show the refusal under
 * the field as the original does.
 */

/** The longest skill or plugin name (the live dialogs' maxLength). */
export const maxDuplicateName = 64;

export const skillNameTaken =
  "You already have a skill with that name. Choose a different one.";
export const pluginNameTaken =
  "You already have a plugin with that name. Choose a different one.";

/** A skill name the agent runtime loads: lower case, digits and hyphens. */
export const skillNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
/** A plugin name as the runtime's plugin-creator writes them. */
export const pluginNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * A typed plugin name as the runtime normalises it (lower case, runs of
 * anything else to one hyphen, no hyphen at either end), cut to 64.
 */
export function pluginSlug(typed: string): string {
  return typed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxDuplicateName)
    .replace(/-+$/, "");
}

/** A SKILL.md's path once its folder is renamed to `name`. */
export function renamedSkillPath(skillPath: string, name: string): string {
  return skillPath.replace(/[^/\\]+(?=[/\\][^/\\]+$)/, name);
}

/**
 * What a typed display name may not contain (the live rule: no < or >, no
 * hidden formatting characters).
 */
export function hasHiddenOrAngle(typed: string): boolean {
  return /[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/.test(
    typed,
  );
}

/**
 * The name a duplicate starts with. A skill or plugin without a display
 * name gets "-copy" after its name, cut so it fits; one with a display name
 * gets the "{name} copy" pattern, which the caller passes translated.
 */
export function copyName(
  name: string,
  displayName?: string,
  pattern = "{name} copy",
): string {
  if (!displayName) return `${[...name].slice(0, 59).join("")}-copy`;
  const room = maxDuplicateName - [...pattern.replace("{name}", "")].length;
  return pattern.replace(
    "{name}",
    [...displayName].slice(0, Math.max(room, 1)).join(""),
  );
}

/**
 * Rename plugin's refusals: the dialog shows these under the field; anything
 * else reads as `pluginRenameFailed`.
 */
export const renameSameName = "Choose a name different from the current one.";
export const nameUnusable = "That name can’t be used. Choose a different one.";
export const pluginRenameFailed = "Plugin rename failed. You can try again.";
/** Duplicate plugin's failure. */
export const pluginDuplicateFailed =
  "Plugin duplicate failed. You can try again.";
export const pluginRenameBusy =
  "Another change to this plugin is still finishing. Try again in a moment.";
/** Live: shown as an error notice, and the dialog closes. */
export const pluginGone =
  "This plugin no longer exists. It may have been deleted from another device.";
export const angleOrHidden =
  "Names can’t contain < or >, or hidden formatting characters.";

/** Typed text with its runs of whitespace made one space (live `Y`). */
export function collapseSpaces(typed: string): string {
  return typed
    .replace(/[\u001c-\u001f\u0085]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** What a Rename plugin entry becomes. */
export interface PluginRenamePlan {
  /** Nothing would change (the dialog refuses it once edited). */
  unchanged: boolean;
  /** The plugin's name afterwards ("Saved as …"). */
  savedAs: string;
  /** The display name to set, when the typed text becomes one. */
  displayName?: string;
}

/**
 * Rename plugin's choice between a new name and a new display name: a plugin
 * whose display name is its name takes the typed text as both (the name
 * slugged); one with a display name of its own keeps it when a plain name is
 * typed, and keeps its name when other text is typed (only the display name
 * changes). `title` is the plugin's own display name, or "" when it has none.
 */
export function pluginRenamePlan(
  typedText: string,
  current: { name: string; title: string },
): PluginRenamePlan {
  const typed = collapseSpaces(typedText);
  const name = pluginSlug(typed);
  const plain = typed === name;
  const unchanged =
    name !== "" &&
    (typed === current.title || (plain && name === current.name));
  if (unchanged) return { unchanged, savedAs: current.name };
  if (current.title === "" || pluginSlug(current.title) === current.name)
    return {
      unchanged,
      savedAs: name,
      ...(current.title === "" && plain ? {} : { displayName: typed }),
    };
  if (plain) return { unchanged, savedAs: name };
  return { unchanged, savedAs: current.name, displayName: typed };
}
