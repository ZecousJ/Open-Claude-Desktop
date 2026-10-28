/**
 * Apps installed on this computer, for the Add app menu of the denied list,
 * for resolving the names the model asks for, for icons on the access card
 * and for opening an app (R10 design §5.1, §5.2).
 *
 * macOS: the .app bundles in the Applications folders (bundle id and name
 * from Info.plist, read with plutil). Windows: the Start menu shortcuts
 * that point at a program (the id is the program name without ".exe", the
 * same name the driver lists).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { app as electronApp, shell } from "electron";
import type { ComputerUseAppRef } from "../../shared/computer-use";

export interface InstalledApp extends ComputerUseAppRef {
  /** The .app bundle (macOS) or the program (Windows). */
  path: string;
}

const cacheMs = 5 * 60_000;

function plistJson(file: string): Promise<any> {
  return new Promise((resolve) =>
    execFile(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", file],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(undefined);
        }
      },
    ),
  );
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

function bundlesIn(folder: string, depth: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.name.endsWith(".app")) found.push(full);
    else if (entry.isDirectory() && depth > 0)
      found.push(...bundlesIn(full, depth - 1));
  }
  return found;
}

async function macApps(): Promise<InstalledApp[]> {
  const folders = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices/Applications",
    path.join(os.homedir(), "Applications"),
  ];
  const bundles = [
    ...new Set(folders.flatMap((folder) => bundlesIn(folder, 1))),
  ];
  const apps = await inBatches(bundles, 8, async (bundle) => {
    const info = await plistJson(path.join(bundle, "Contents", "Info.plist"));
    const id = info?.CFBundleIdentifier;
    if (typeof id !== "string" || !id) return undefined;
    const name =
      (typeof info.CFBundleDisplayName === "string" &&
        info.CFBundleDisplayName) ||
      (typeof info.CFBundleName === "string" && info.CFBundleName) ||
      path.basename(bundle, ".app");
    return { id, name, platform: "darwin", path: bundle } as InstalledApp;
  });
  return apps.filter((app): app is InstalledApp => Boolean(app));
}

function shortcutsIn(folder: string, depth: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk"))
      found.push(full);
    else if (entry.isDirectory() && depth > 0)
      found.push(...shortcutsIn(full, depth - 1));
  }
  return found;
}

function windowsApps(): InstalledApp[] {
  const roots = [
    process.env.ProgramData &&
      path.join(
        process.env.ProgramData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      ),
    process.env.APPDATA &&
      path.join(
        process.env.APPDATA,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      ),
  ].filter((root): root is string => Boolean(root));
  const apps: InstalledApp[] = [];
  for (const shortcut of roots.flatMap((root) => shortcutsIn(root, 2))) {
    let target = "";
    try {
      target = shell.readShortcutLink(shortcut).target;
    } catch {
      continue;
    }
    if (!target.toLowerCase().endsWith(".exe")) continue;
    const id = path.basename(target).replace(/\.exe$/i, "");
    // Uninstallers and helpers are not apps anyone denies or opens.
    if (/^(unins\d*|uninstall|update|setup)$/i.test(id)) continue;
    apps.push({
      id,
      name: path.basename(shortcut).replace(/\.lnk$/i, ""),
      platform: "win32",
      path: target,
    });
  }
  return apps;
}

export class InstalledApps {
  private cached?: { at: number; apps: Promise<InstalledApp[]> };
  private icons = new Map<string, string | undefined>();

  list(): Promise<InstalledApp[]> {
    if (!this.cached || Date.now() - this.cached.at > cacheMs) {
      const apps = (async () => {
        const found =
          process.platform === "darwin"
            ? await macApps()
            : process.platform === "win32"
              ? windowsApps()
              : [];
        const seen = new Set<string>();
        return found
          .filter((app) => {
            const key = app.id.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      })();
      this.cached = { at: Date.now(), apps };
      apps.catch(() => (this.cached = undefined));
    }
    return this.cached.apps;
  }

  /** The app's icon as a data URL (cached), when the system has one. */
  async icon(app: InstalledApp): Promise<string | undefined> {
    if (this.icons.has(app.path)) return this.icons.get(app.path);
    let icon: string | undefined;
    try {
      const image = await electronApp.getFileIcon(app.path, { size: "normal" });
      icon = image.isEmpty() ? undefined : image.toDataURL();
    } catch {}
    this.icons.set(app.path, icon);
    return icon;
  }

  async withIcons(): Promise<(ComputerUseAppRef & { icon?: string })[]> {
    const apps = await this.list();
    return inBatches(apps, 16, async (app) => {
      const icon = await this.icon(app);
      return {
        id: app.id,
        name: app.name,
        platform: app.platform,
        ...(icon ? { icon } : {}),
      };
    });
  }
}
