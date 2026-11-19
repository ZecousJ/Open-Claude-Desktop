/**
 * The ZecousAI → Claudex bridge's pure logic (tools/zecous-bridge, docs/ota.md):
 * how it was started, where things are, what it removes. No Electron
 * imports; unit-tested in tests/zecous-bridge.test.ts.
 */
import path from "node:path";

const win = path.win32;

export type SquirrelEvent =
  "install" | "updated" | "uninstall" | "obsolete" | "firstrun";

export interface BridgeArgs {
  /** Squirrel.Windows hook the app was started for (it must exit quickly, except firstrun). */
  squirrelEvent?: SquirrelEvent;
  /** `/S`: started by ZecousAI's old NSIS updater as a silent installer. */
  silent: boolean;
  /** `/D=<dir>`: the old ZecousAI install folder (Claudex is not installed there). */
  installDir?: string;
}

/**
 * Reads the command line. ZecousAI's NSIS updater runs the package as
 * `<exe> /S /NORESTART /currentuser /D=<ZecousAI folder>`; `/D=` is last
 * and unquoted, so it may contain spaces and runs to the end of the line.
 */
export function parseBridgeArgs(argv: readonly string[]): BridgeArgs {
  const result: BridgeArgs = { silent: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const squirrel =
      /^--squirrel-(install|updated|uninstall|obsolete|firstrun)$/i.exec(arg);
    if (squirrel)
      result.squirrelEvent = squirrel[1].toLowerCase() as SquirrelEvent;
    else if (/^\/S$/i.test(arg)) result.silent = true;
    else if (/^\/D=/i.test(arg)) {
      const dir = [arg.slice(3), ...argv.slice(index + 1)].join(" ").trim();
      if (dir && win.isAbsolute(dir)) result.installDir = win.normalize(dir);
      break;
    }
  }
  return result;
}

/**
 * Squirrel installs run as `<root>\app-<version>\ZecousAI.exe` beside
 * `<root>\Update.exe`; anything else is the old NSIS (or portable) install.
 */
export function bridgeMode(
  execPath: string,
  exists: (file: string) => boolean,
): "squirrel" | "nsis" {
  return exists(squirrelUpdateExe(execPath)) ? "squirrel" : "nsis";
}

export const squirrelUpdateExe = (execPath: string) =>
  win.resolve(win.dirname(execPath), "..", "Update.exe");

/** Where the per-user Claudex NSIS installer puts Claudex (electron-builder's default). */
export function claudexInstallDir(
  env: Record<string, string | undefined>,
  home: string,
) {
  return win.join(
    env.LOCALAPPDATA || win.join(home, "AppData", "Local"),
    "Programs",
    "Claudex",
  );
}

export const claudexExe = (installDir: string) =>
  win.join(installDir, "Claudex.exe");

/** The Claudex installer's silent, per-user command line. */
export const claudexInstallerArgs = () => ["/S", "/currentuser"];

/**
 * The old NSIS install folder the bridge may delete: only an absolute
 * folder that holds ZecousAI.exe and is not a drive root, the user's home or
 * a system folder, and never Claudex's own folder.
 */
export function removableZecousFolder(
  dir: string | undefined,
  options: {
    exists: (file: string) => boolean;
    home: string;
    claudexDir: string;
  },
): string | undefined {
  if (!dir || !win.isAbsolute(dir)) return undefined;
  const folder = win.normalize(dir).replace(/\\+$/, "");
  const lower = folder.toLowerCase();
  if (/^[a-z]:$/i.test(folder)) return undefined;
  const refused = [
    options.home,
    options.claudexDir,
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].map((item) => win.normalize(item).replace(/\\+$/, "").toLowerCase());
  if (refused.includes(lower)) return undefined;
  if (!options.exists(win.join(folder, "ZecousAI.exe"))) return undefined;
  return folder;
}

/** ZecousAI's shortcuts (Desktop and Start menu), removed with it. */
export function zecousShortcuts(
  env: Record<string, string | undefined>,
  home: string,
) {
  const appData = env.APPDATA || win.join(home, "AppData", "Roaming");
  const programs = win.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  return [
    win.join(env.USERPROFILE || home, "Desktop", "ZecousAI.lnk"),
    win.join(programs, "ZecousAI.lnk"),
    win.join(programs, "ZecousAI", "ZecousAI.lnk"),
  ];
}

/** What the build baked in (dist/bridge-config.json). */
export interface BridgeConfig {
  /** https address of the Claudex NSIS installer; absent when the installer is embedded. */
  installerUrl?: string;
  /** File name of the embedded installer in the app's resources. */
  embeddedInstaller?: string;
  installerSha256: string;
  claudexVersion: string;
  serviceUrl: string;
}

export function parseBridgeConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== "object")
    throw new Error("The bridge has no configuration.");
  const config = value as Record<string, unknown>;
  const sha256 = String(config.installerSha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("The bridge has no installer checksum.");
  const url =
    typeof config.installerUrl === "string" ? config.installerUrl : undefined;
  const embedded =
    typeof config.embeddedInstaller === "string" &&
    /^[\w.-]+\.exe$/i.test(config.embeddedInstaller)
      ? config.embeddedInstaller
      : undefined;
  if (!embedded) {
    if (!url) throw new Error("The bridge has no installer address.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error("The installer address must be plain https.");
  }
  const serviceUrl = String(config.serviceUrl ?? "");
  if (!/^https:\/\/[^/?#@]+(\/[^?#]*)?$/.test(serviceUrl))
    throw new Error("The service address must be https.");
  const claudexVersion = String(config.claudexVersion ?? "");
  if (!/^\d+\.\d+\.\d+([.+-][\w.+-]*)?$/.test(claudexVersion))
    throw new Error("The Claudex version is missing.");
  return {
    ...(embedded ? { embeddedInstaller: embedded } : { installerUrl: url }),
    installerSha256: sha256,
    claudexVersion,
    serviceUrl: serviceUrl.replace(/\/+$/, ""),
  };
}

/**
 * A detached cmd line that waits for this process to exit and then removes
 * the old folder and shortcuts (cmd quoting: paths never contain quotes).
 */
export function cleanupCommand(targets: {
  folders: string[];
  files: string[];
  /** Removed only when empty (`rmdir` without /s). */
  emptyFolders?: string[];
}) {
  const safe = (item: string) => {
    if (item.includes('"') || /[\r\n%^&|<>]/.test(item))
      throw new Error(`Unsafe path: ${item}`);
    return `"${item}"`;
  };
  const steps = [
    "ping -n 4 127.0.0.1 >nul",
    ...targets.files.map((file) => `del /f /q ${safe(file)}`),
    ...targets.folders.map((folder) => `rmdir /s /q ${safe(folder)}`),
    ...(targets.emptyFolders ?? []).map((folder) => `rmdir ${safe(folder)}`),
  ];
  return steps.join(" & ");
}

/** ZecousAI's own Start menu folder (Squirrel puts its shortcut there). */
export function zecousStartMenuFolder(
  env: Record<string, string | undefined>,
  home: string,
) {
  const appData = env.APPDATA || win.join(home, "AppData", "Roaming");
  return win.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "ZecousAI",
  );
}

/**
 * After `Update.exe --uninstall`: waits longer than the plain cleanup (the
 * uninstall and this process must both have exited), then removes the
 * Squirrel root, the shortcuts and ZecousAI's Start menu folder. The root
 * must be a ZecousAI Squirrel root, never anything else.
 */
export function squirrelCleanupCommand(
  root: string,
  shortcuts: string[],
  startMenuFolder: string,
) {
  if (!/[\\/]ZecousAI$/i.test(root.replace(/[\\/]+$/, "")))
    throw new Error(`Not a ZecousAI folder: ${root}`);
  // Squirrel's update also files a shortcut folder under the company name
  // ("Zecous"); its shortcut goes with the uninstall, the folder stays empty.
  return (
    cleanupCommand({
      folders: [root, startMenuFolder],
      files: shortcuts,
      emptyFolders: [win.join(win.dirname(startMenuFolder), "Zecous")],
    })
      .replace("ping -n 4 127.0.0.1 >nul", "ping -n 16 127.0.0.1 >nul")
      // Squirrel's uninstall may still hold the version folder at the first
      // pass (an empty app-x.y.z stayed on winpc): once more a bit later.
      .concat(` & ping -n 11 127.0.0.1 >nul & rmdir /s /q "${root}"`)
  );
}
