import fs from "node:fs";
import path from "node:path";
import {
  angleOrHidden,
  hasHiddenOrAngle,
  maxDuplicateName,
  pluginGone,
  pluginNamePattern,
  pluginNameTaken,
  renameSameName,
} from "../../shared/duplicate-name";
import { copyFolderFiles } from "../skills/skill-folder";

/**
 * Duplicate plugin's files. The agent runtime reads a personal marketplace at
 * ~/.agents/plugins/marketplace.json whose plugins sit in ~/plugins/<name> (its
 * plugin-creator's convention: marketplace "personal", entries with a local
 * source, an AVAILABLE policy and a category), so the copy goes there and the
 * runtime lists and installs it like any other.
 */

/** Where the personal marketplace keeps its file and its plugins. */
export function personalMarketplace(home: string) {
  return {
    file: path.join(home, ".agents", "plugins", "marketplace.json"),
    plugins: path.join(home, "plugins"),
  };
}

/** Whether two paths name the same place (links and /private resolved). */
export function samePath(a: string, b: string): boolean {
  const real = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

const manifests = [
  path.join(".codex-plugin", "plugin.json"),
  path.join(".claude-plugin", "plugin.json"),
];
const authPolicies = new Set(["ON_INSTALL", "ON_USE"]);
const unreadableMarket =
  "Your personal plugin marketplace file can’t be read. Fix ~/.agents/plugins/marketplace.json and try again.";

/** The personal marketplace's file as an object (a new one when absent). */
function parseMarket(previous: string | undefined): any {
  let market: any;
  try {
    market =
      previous === undefined
        ? {
            name: "personal",
            interface: { displayName: "Personal" },
            plugins: [],
          }
        : JSON.parse(previous);
  } catch {
    throw Error(unreadableMarket);
  }
  if (!market || typeof market !== "object" || Array.isArray(market))
    throw Error(unreadableMarket);
  if (!Array.isArray(market.plugins)) market.plugins = [];
  return market;
}

/** A typed display name the runtime may show, or a refusal. */
function checkDisplayName(value: string | undefined): string | undefined {
  const displayName = value?.trim();
  if (
    displayName !== undefined &&
    (!displayName ||
      [...displayName].length > maxDuplicateName ||
      hasHiddenOrAngle(displayName))
  )
    throw Error(angleOrHidden);
  return displayName;
}

/**
 * Writes `name` (and the display name, when given) into the plugin's own
 * manifests under `folder`, adding the runtime's when it has none. Answers
 * how to put them back.
 */
function nameManifests(
  folder: string,
  name: string,
  displayName: string | undefined,
): () => void {
  const found = manifests.filter((file) =>
    fs.existsSync(path.join(folder, file)),
  );
  const before = new Map<string, string | undefined>();
  const restore = () => {
    for (const [full, text] of before)
      if (text === undefined) fs.rmSync(full, { force: true });
      else fs.writeFileSync(full, text);
  };
  try {
    for (const file of found.length ? found : [manifests[0]]) {
      const full = path.join(folder, file);
      let manifest: any = {};
      const text = fs.existsSync(full)
        ? fs.readFileSync(full, "utf8")
        : undefined;
      if (text !== undefined) {
        try {
          manifest = JSON.parse(text);
        } catch {
          throw Error("This plugin’s manifest can’t be read.");
        }
        if (
          !manifest ||
          typeof manifest !== "object" ||
          Array.isArray(manifest)
        )
          throw Error("This plugin’s manifest can’t be read.");
      }
      manifest.name = name;
      if (displayName) {
        if (!manifest.interface || typeof manifest.interface !== "object")
          manifest.interface = {};
        manifest.interface.displayName = displayName;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      before.set(full, text);
      fs.writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

/** What the copy needs to know about the plugin it copies. */
export interface PluginCopySource {
  /** The plugin's folder (its listing's local source path). */
  folder: string;
  /** Its marketplace category as listed ("Productivity"). */
  category?: string;
  authPolicy?: string;
}

/** Answers how to undo the copy (used when installing it fails). */
export function duplicatePluginFiles(
  source: PluginCopySource,
  copy: { name: string; displayName?: string },
  home: string,
): { marketplacePath: string; undo: () => void } {
  const name = copy.name;
  if (!pluginNamePattern.test(name))
    throw Error(
      "Names can only contain lowercase letters, numbers, and hyphens.",
    );
  const displayName = checkDisplayName(copy.displayName);
  const stat = fs.lstatSync(source.folder, { throwIfNoEntry: false });
  if (!stat?.isDirectory())
    throw Error(
      "This plugin’s files aren’t on this computer, so it can’t be duplicated.",
    );
  const places = personalMarketplace(home);
  const previous = fs.existsSync(places.file)
    ? fs.readFileSync(places.file, "utf8")
    : undefined;
  const market = parseMarket(previous);
  const target = path.join(places.plugins, name);
  if (
    fs.existsSync(target) ||
    market.plugins.some((entry: any) => entry?.name === name)
  )
    throw Error(pluginNameTaken);

  fs.mkdirSync(places.plugins, { recursive: true });
  const staging = fs.mkdtempSync(path.join(places.plugins, ".duplicate-"));
  try {
    copyFolderFiles(source.folder, staging, {
      files: 5000,
      bytes: 200 * 1024 * 1024,
      message: "Plugins can be copied up to 5,000 files and 200 MB.",
    });
    // The copy's own manifest names it (and shows the typed name).
    nameManifests(staging, name, displayName);
    if (fs.existsSync(target)) throw Error(pluginNameTaken);
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  market.plugins.push({
    name,
    source: { source: "local", path: `./plugins/${name}` },
    policy: {
      installation: "AVAILABLE",
      authentication: authPolicies.has(source.authPolicy ?? "")
        ? source.authPolicy
        : "ON_INSTALL",
    },
    category: source.category || "Productivity",
  });
  try {
    writeAtomically(places.file, `${JSON.stringify(market, null, 2)}\n`);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return {
    marketplacePath: places.file,
    undo: () => {
      fs.rmSync(target, { recursive: true, force: true });
      if (previous === undefined) {
        fs.rmSync(places.file, { force: true });
        return;
      }
      // Only this copy's entry goes; anything added meanwhile stays.
      try {
        const now = JSON.parse(fs.readFileSync(places.file, "utf8"));
        now.plugins = (now.plugins ?? []).filter(
          (entry: any) => entry?.name !== name,
        );
        writeAtomically(places.file, `${JSON.stringify(now, null, 2)}\n`);
      } catch {
        writeAtomically(places.file, previous);
      }
    },
  };
}

/**
 * Rename plugin's files. The plugin's entry in the personal marketplace and its
 * manifests take the new name (and display name, when given); a folder at
 * ~/plugins/<old name> moves to ~/plugins/<new name>, as Duplicate would have
 * placed it. A folder kept elsewhere stays where it is. Answers how to put
 * everything back (used when reinstalling under the new id fails).
 */
export function renamePluginFiles(
  plugin: { name: string; folder: string },
  to: { name: string; displayName?: string },
  home: string,
): { folder: string; undo: () => void } {
  if (!pluginNamePattern.test(to.name))
    throw Error(
      "Names can only contain lowercase letters, numbers, and hyphens.",
    );
  const displayName = checkDisplayName(to.displayName);
  const moving = to.name !== plugin.name;
  if (!moving && displayName === undefined) throw Error(renameSameName);
  const stat = fs.statSync(plugin.folder, { throwIfNoEntry: false });
  if (!stat?.isDirectory())
    throw Error(
      "This plugin’s files aren’t on this computer, so it can’t be renamed.",
    );
  const places = personalMarketplace(home);
  if (!fs.existsSync(places.file)) throw Error(pluginGone);
  const previous = fs.readFileSync(places.file, "utf8");
  const market = parseMarket(previous);
  const entry = market.plugins.find((item: any) => item?.name === plugin.name);
  if (!entry) throw Error(pluginGone);
  // A folder Duplicate (or the runtime's plugin-creator) placed follows the
  // name; one the person keeps elsewhere is left in place.
  const owned =
    moving && samePath(plugin.folder, path.join(places.plugins, plugin.name));
  const folder = owned ? path.join(places.plugins, to.name) : plugin.folder;
  if (
    moving &&
    (market.plugins.some((item: any) => item?.name === to.name) ||
      (owned && fs.existsSync(folder)))
  )
    throw Error(pluginNameTaken);

  if (owned) fs.renameSync(plugin.folder, folder);
  const moveBack = () => {
    if (owned) fs.renameSync(folder, plugin.folder);
  };
  let restoreManifests: () => void;
  try {
    restoreManifests = nameManifests(folder, to.name, displayName);
  } catch (error) {
    moveBack();
    throw error;
  }
  entry.name = to.name;
  if (owned && entry.source && typeof entry.source === "object") {
    const before = String(entry.source.path ?? "");
    entry.source.path = path.isAbsolute(before)
      ? folder
      : `./plugins/${to.name}`;
  }
  const undo = () => {
    restoreManifests();
    moveBack();
    writeAtomically(places.file, previous);
  };
  try {
    writeAtomically(places.file, `${JSON.stringify(market, null, 2)}\n`);
  } catch (error) {
    restoreManifests();
    moveBack();
    throw error;
  }
  return { folder, undo };
}

function writeAtomically(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}
