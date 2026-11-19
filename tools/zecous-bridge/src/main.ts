/**
 * ZecousAI 1.0.31, the bridge to Claudex (docs/ota.md). ZecousAI's updater
 * installs this as its next version; on start it shows "Updating to
 * Claudex…", installs Claudex silently (installer checked against the
 * SHA-256 baked in at build time), points Claudex at the Claudex service
 * (and suggests the email ZecousAI knew), opens Claudex and removes
 * ZecousAI. Windows only. Bundled by build.mjs into dist/main.cjs.
 */
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  downloadVerified,
  fileSha256,
} from "../../../electron/updates/download";
import {
  defaultUserData,
  zecousHandoff,
  zecousStoreFile,
} from "../../../electron/updates/zecous-handoff";
import {
  bridgeMode,
  claudexExe,
  claudexInstallDir,
  claudexInstallerArgs,
  cleanupCommand,
  parseBridgeArgs,
  parseBridgeConfig,
  removableZecousFolder,
  squirrelUpdateExe,
  squirrelCleanupCommand,
  zecousShortcuts,
  zecousStartMenuFolder,
} from "./logic";

const args = parseBridgeArgs(process.argv.slice(1));
const home = os.homedir();
const env = process.env;

/**
 * Starts a process that outlives this one. It never starts in this app's
 * folder: Windows keeps a process's current folder, and the Squirrel
 * version folder (app-1.0.31) then stayed behind, empty but undeletable,
 * while Claudex ran (found on winpc, 2026-10-07).
 */
function runDetached(
  command: string,
  commandArgs: string[],
  cwd: string = os.tmpdir(),
) {
  spawn(command, commandArgs, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/**
 * Runs a cmd.exe line after this process exits. The line goes to cmd as is:
 * spawn's own quoting turns the paths' quotes into \\" that cmd cannot read,
 * and the whole line failed (found on winpc, 2026-10-07).
 */
function runCmdDetached(line: string) {
  spawn(
    process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/c", line],
    {
      cwd: os.tmpdir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  ).unref();
}

// Squirrel hooks: nothing to set up, and uninstall only removes shortcuts.
if (args.squirrelEvent && args.squirrelEvent !== "firstrun") {
  if (args.squirrelEvent === "uninstall")
    try {
      runDetached(squirrelUpdateExe(process.execPath), [
        `--removeShortcut=${path.win32.basename(process.execPath)}`,
      ]);
    } catch {
      /* Nothing to remove. */
    }
  app.quit();
} else if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(run);

const page = (text: string, detail = "") =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Claudex</title><style>
html,body{margin:0;height:100%;background:#1f1e1d;color:#f0efec;font:14px -apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
main{display:flex;flex-direction:column;justify-content:center;height:100%;padding:0 24px;box-sizing:border-box;-webkit-app-region:drag}
p{margin:0}small{margin-top:6px;color:#9a9893;font-size:12px}
</style></head><body><main><p>${text}</p><small>${detail}</small></main></body></html>`)}`;

async function run() {
  const window = new BrowserWindow({
    width: 360,
    height: 120,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: "Claudex",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#1f1e1d",
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      javascript: false,
    },
  });
  const show = (text: string, detail = "") =>
    window.isDestroyed() ? undefined : void window.loadURL(page(text, detail));
  show("Updating to Claudex…");
  try {
    const config = parseBridgeConfig(
      JSON.parse(
        fs.readFileSync(path.join(__dirname, "bridge-config.json"), "utf8"),
      ),
    );
    const updates = path.join(app.getPath("temp"), "claudex-bridge");
    fs.mkdirSync(updates, { recursive: true });
    let installer: string;
    if (config.embeddedInstaller) {
      installer = path.join(process.resourcesPath, config.embeddedInstaller);
      if ((await fileSha256(installer)) !== config.installerSha256)
        throw new Error("The Claudex installer doesn't match its checksum.");
    } else {
      installer = path.join(
        updates,
        `Claudex-Setup-${config.claudexVersion}.exe`,
      );
      await downloadVerified({
        url: config.installerUrl!,
        file: installer,
        sha256: config.installerSha256,
        attempts: 10,
        onProgress: (received, total) =>
          total &&
          show(
            "Updating to Claudex…",
            `Downloading ${Math.floor((received / total) * 100)}%`,
          ),
      });
    }
    show("Updating to Claudex…", "Installing");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(installer, claudexInstallerArgs(), {
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (exit) => resolve(exit ?? 1));
    });
    const claudexDir = claudexInstallDir(env, home);
    if (code !== 0 || !fs.existsSync(claudexExe(claudexDir)))
      throw new Error(`The Claudex installer stopped (code ${code}).`);
    // Claudex's service and the email ZecousAI knew; no tokens are copied.
    zecousHandoff({
      userData: defaultUserData("Claudex", "win32", env, home),
      zecousStore: zecousStoreFile("win32", env, home),
      serviceUrl: config.serviceUrl,
      fromZecousAI: true,
    });
    runDetached(claudexExe(claudexDir), [], claudexDir);
    // Remove ZecousAI once this process has exited.
    if (bridgeMode(process.execPath, fs.existsSync) === "squirrel") {
      // Squirrel's uninstall leaves the running version, Update.exe and the
      // Start menu entry behind (this process still holds them): clear them
      // once both have exited.
      runDetached(squirrelUpdateExe(process.execPath), ["--uninstall"]);
      runCmdDetached(
        squirrelCleanupCommand(
          path.dirname(squirrelUpdateExe(process.execPath)),
          zecousShortcuts(env, home).filter((file) => fs.existsSync(file)),
          zecousStartMenuFolder(env, home),
        ),
      );
    } else {
      const folder = removableZecousFolder(args.installDir, {
        exists: fs.existsSync,
        home,
        claudexDir,
      });
      runCmdDetached(
        cleanupCommand({
          folders: folder ? [folder] : [],
          files: zecousShortcuts(env, home).filter((file) =>
            fs.existsSync(file),
          ),
        }),
      );
    }
    fs.rmSync(updates, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    show(
      "Couldn't update to Claudex",
      `${error instanceof Error ? error.message : String(error)} Close this window and open ZecousAI again to retry.`,
    );
    window.on("closed", () => app.exit(1));
  }
}
