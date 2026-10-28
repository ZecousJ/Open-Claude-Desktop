import fs from "node:fs";
import path from "node:path";

function directory(folder: string) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(folder).isDirectory())
    throw new Error("The Codex cache directory is not a directory.");
}

function homeInProfile(profile: string, root: string, create: boolean) {
  const relative = path.relative(profile, root);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("The Codex home is outside the profile.");
  let current = profile;
  for (const part of [
    "",
    ...relative.split(path.sep).filter(Boolean),
    "codex-home",
  ]) {
    current = path.join(current, part);
    if (create) directory(current);
    else if (!fs.lstatSync(current, { throwIfNoEntry: false })?.isDirectory())
      return undefined;
  }
  return current;
}

export function codexCacheRoot(profile: string) {
  return path.join(profile, "codex-cache");
}

/** Codex 0.144.1 core-plugins/src/startup_sync.rs locks .tmp/plugins.sync.lock
 * and stages/renames .tmp/plugins. Share their parent, not just the repo.
 */
export function prepareCodexCache(profile: string, root: string) {
  const home = homeInProfile(profile, root, true)!;
  const shared = codexCacheRoot(profile);
  const temporary = path.join(home, ".tmp");
  const existing = fs.lstatSync(temporary, { throwIfNoEntry: false });
  if (
    existing?.isSymbolicLink() &&
    path.resolve(home, fs.readlinkSync(temporary)) === shared
  ) {
    directory(shared);
    return shared;
  }
  if (existing?.isDirectory() && !fs.existsSync(shared))
    fs.renameSync(temporary, shared);
  else if (existing) fs.rmSync(temporary, { recursive: true, force: true });
  directory(shared);
  fs.symlinkSync(
    shared,
    temporary,
    process.platform === "win32" ? "junction" : "dir",
  );
  return shared;
}

/** Only a stopped home's disposable .tmp; rm never follows its symlink. */
export function pruneCodexCache(profile: string, root: string) {
  const home = homeInProfile(profile, root, false);
  if (home)
    fs.rmSync(path.join(home, ".tmp"), { recursive: true, force: true });
}

export function pruneIdleSpaceCaches(
  profile: string,
  active: ReadonlySet<string>,
) {
  const spaces = path.join(profile, "spaces");
  if (!fs.lstatSync(spaces, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const entry of fs.readdirSync(spaces, { withFileTypes: true })) {
    if (!entry.isDirectory() || active.has(entry.name)) continue;
    try {
      pruneCodexCache(profile, path.join(spaces, entry.name));
    } catch (error) {
      console.error("claudex: cache cleanup failed", error);
    }
  }
}

export function cachePressure(usedBytes: number, limitBytes: number) {
  return limitBytes > 0 && usedBytes >= limitBytes * 0.85;
}
