/**
 * The updater's two hooks in main.ts (docs/releasing.md):
 *
 * - `prepareLaunch()` runs first when the app is ready, before any account
 *   or window: it moves a misnamed macOS bundle to Claudex.app, installs a
 *   validates a staged update left at the last quit. When it returns true
 *   this process is exiting and main must not continue.
 * - `startAppUpdates(ctx)` starts the updater: background checks, the
 *   `app-update` event, Relaunch to update and the install at quit.
 */
import { quitConfirmation } from "../app/quit-confirmation";
import { installHoldMs } from "../app/shutdown";
import { app, autoUpdater, BrowserWindow, net, powerMonitor } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { LinuxPackage } from "../../shared/app-update";
import os from "node:os";
import type { AppContext } from "../app/app-context";
import { defaultClaudexServiceUrl } from "../../shared/claudex-service";
import { loadSub2ApiConfig } from "../../server/sub2api-config";
import { Sub2ApiClient } from "../sub2api/client";
import { startInstall } from "./apply";
import { relocateBundle } from "./relocate";
import {
  launchDecision,
  readApplyResult,
  readStaged,
  updatesDir,
} from "./staging";
import { AppUpdater } from "./updater";
import { keepDigest } from "./app-pack";
import { preference } from "../../shared/settings-extras";
import { ensureAppOwnership } from "./ownership-dialog";
import { StealthUpdate } from "./stealth";
import { saveStealthWindow } from "./stealth-window";
import { UpdateLifecycle } from "./lifecycle";
import { beginUpdateSession } from "./session";
import { parseUpdatePolicy } from "../../shared/update-policy";
import { deviceId } from "../sub2api/provision";
import {
  NativeAppUpdater,
  squirrelFeedUrl,
  squirrelWindowsExecutable,
} from "./native";
import { clearShipItStage, removeUserShipItJob, shipItStderr } from "./shipit";
import { EarlyUpdateInstall } from "./early-install";
import { FeedArchitecture } from "./feed-architecture";

const log = (message: string, error?: unknown) =>
  console.error(
    `Claudex updates: ${message}`,
    error instanceof Error ? error.message : (error ?? ""),
  );

function serviceUrl(userData: string) {
  try {
    return loadSub2ApiConfig(userData).baseUrl || undefined;
  } catch {
    return undefined;
  }
}

/** See the file comment. True: this process is exiting. */
export async function prepareLaunch(): Promise<boolean> {
  if (!app.isPackaged) return false;
  const userData = app.getPath("userData");
  const dir = updatesDir(userData);
  if (process.platform === "darwin") {
    const moved = relocateBundle({
      execPath: process.execPath,
      version: app.getVersion(),
      pid: process.pid,
      scriptDir: dir,
    });
    if (moved.relaunch) {
      app.exit(0);
      return true;
    }
    if (moved.error)
      log("the app couldn't be renamed to Claudex.app", moved.error);
  }
  const result = readApplyResult(dir);
  if (result && !result.ok)
    log(`installing ${result.version} failed`, result.error);
  launchDecision(dir, app.getVersion());
  try {
    updateSession = beginUpdateSession(
      userData,
      process.pid,
      Date.now() - os.uptime() * 1000,
      (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      },
    );
    app.once("quit", () => updateSession?.clean());
  } catch (error) {
    log("running-instance sentinel unavailable", error);
  }
  return false;
}

/**
 * How this Linux copy was installed: the deb or rpm package that owns the
 * executable, or the install script's tarball in /opt/claudex; undefined
 * (no updates) for a copy run from anywhere else.
 */
function linuxPackageOf(execPath: string): LinuxPackage | undefined {
  const owns = (command: string, args: string[]) => {
    try {
      execFileSync(command, args, { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  };
  if (owns("dpkg-query", ["-S", execPath])) return "deb";
  if (owns("rpm", ["-qf", execPath])) return "rpm";
  if (execPath.startsWith("/opt/claudex/")) return "tar";
  return undefined;
}

let updater: AppUpdater | NativeAppUpdater | undefined;
/** Set by Relaunch to update: the helper opens the new version. */
let relaunchAfterInstall = false;
let backgroundInstall = false;
let quitting = false;
let updateSession: ReturnType<typeof beginUpdateSession> | undefined;
const launchedAt = Date.now();
let shipItFailureLogged = false;

export function setUpdateQuitInProgress(value: boolean) {
  quitting = value;
}

/** Whether the quit under way is Relaunch to update (it installs, then reopens). */
export const updateRelaunchRequested = () => relaunchAfterInstall;

/** The running updater (undefined before startAppUpdates). */
export const appUpdater = () => updater;
let updateEndpoints: NonNullable<
  import("../../shared/app-update-api").AppEnvironment["updateEndpoints"]
> = [];
export const appUpdateEndpoints = () =>
  updateEndpoints.map((endpoint) => ({ ...endpoint }));

const statusListeners = new Set<() => void>();
/** Called on every status change (the app menu's label). */
export function onAppUpdateStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => void statusListeners.delete(listener);
}

export function startAppUpdates(ctx: AppContext) {
  if (updater) return updater;
  const userData = app.getPath("userData");
  let policy = parseUpdatePolicy(undefined);
  try {
    policy = parseUpdatePolicy(
      JSON.parse(
        fs.readFileSync(path.join(userData, "update-policy.json"), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log("update policy could not be read", error);
  }
  const linuxPackage =
    process.platform === "linux" ? linuxPackageOf(process.execPath) : undefined;
  const device = {
    deviceId: deviceId(userData),
    version: app.getVersion(),
    osVersion: process.getSystemVersion(),
    maxVersion: policy.maxVersion,
    channelUuid: policy.channelUuid,
  };
  const nativeInstalled =
    process.platform === "darwin" ||
    (process.platform === "win32" &&
      fs.existsSync(squirrelWindowsExecutable(process.execPath)));
  const updateBase =
    policy.updatesHost ?? serviceUrl(userData) ?? defaultClaudexServiceUrl;
  // A build without a service checks for updates once one is chosen
  // (setServiceAddress starts them again).
  if (!updateBase) return undefined;
  updateEndpoints = [
    {
      url:
        app.isPackaged && nativeInstalled && policy.squirrelFeedUrl
          ? policy.squirrelFeedUrl
          : `${updateBase.replace(/\/$/, "")}/api/v1/claudex/release`,
      purpose: "Update feed",
    },
  ];
  const recordBinaryEndpoint = (value: unknown) => {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return;
      updateEndpoints[1] = {
        url: url.origin + url.pathname,
        purpose: "Update binaries",
      };
    } catch {
      /* Only list actual, valid release endpoints. */
    }
  };
  const onStatus = (
    status: import("../../shared/app-update-api").AppUpdateStatus,
  ) => {
    ctx.push({ type: "app-update", status });
    statusListeners.forEach((listener) => listener());
    if (status.retry && process.platform === "darwin" && !shipItFailureLogged) {
      shipItFailureLogged = true;
      const stderr = shipItStderr(os.homedir());
      if (stderr) log("ShipIt stderr tail for failed install", stderr);
    }
  };
  const earlyInstall = new EarlyUpdateInstall(() => {
    quitting = true;
    relaunchToUpdate();
  });
  const checkEarlyInstall = () => {
    let busy = false;
    try {
      busy = ctx.engines.isBusy();
    } catch {
      /* No account yet. */
    }
    earlyInstall.update({
      mainWindow: !!ctx.appWindows.main(),
      busy,
      ready: updater?.status().phase === "ready",
      enabled:
        !quitting && !!updater?.supported() && process.platform !== "linux",
    });
  };
  checkEarlyInstall();
  const onDownloaded = () => {
    earlyInstall.onDownloaded();
    checkEarlyInstall();
  };
  const offerInterface = (
    ui: Parameters<typeof import("../ui-pack/launch").offerUiPack>[0],
  ) =>
    void import("../ui-pack/launch")
      .then(({ offerUiPack }) => offerUiPack(ui ?? null))
      .catch((error) => console.error("[ui-pack] offer failed:", error));
  let updaterConfig:
    import("../../shared/update-policy").DesktopUpdaterConfig | undefined;
  const feedArchitecture = new FeedArchitecture(async (url) => {
    const response = await net.fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      void response.json().then(
        (release) => recordBinaryEndpoint(release.url),
        () => {},
      );
    } else void response.body?.cancel().catch(() => {});
    return response.status;
  });
  updater =
    app.isPackaged && nativeInstalled && policy.squirrelFeedUrl
      ? new NativeAppUpdater({
          driver: autoUpdater,
          feedUrl: squirrelFeedUrl(policy.squirrelFeedUrl, device),
          selectFeed: async () => {
            const selected = await feedArchitecture.select(
              squirrelFeedUrl(policy.squirrelFeedUrl!, device),
              process.platform === "darwin" && app.runningUnderARM64Translation
                ? "arm64"
                : process.arch,
            );
            const url = new URL(selected);
            updateEndpoints[0] = {
              url: url.origin + url.pathname,
              purpose: "Update feed",
            };
            return selected;
          },
          clearFeedProbe: () => feedArchitecture.clear(),
          disableAutoUpdates: policy.disableAutoUpdates,
          updaterConfig: () => updaterConfig,
          currentVersion: app.getVersion(),
          userData,
          onStatus,
          onDownloaded,
          log,
          peekVersion: async () => {
            const response = await net.fetch(
              squirrelFeedUrl(policy.squirrelFeedUrl!, device),
              { signal: AbortSignal.timeout(5000) },
            );
            if (!response.ok) return null;
            const data = await response.json();
            recordBinaryEndpoint(data.url);
            updaterConfig = data.desktop_updater_config;
            const version: unknown = data.currentRelease ?? data.version;
            // The Squirrel feed has no interface pack; the service's answer does.
            void new Sub2ApiClient(
              policy.updatesHost ??
                serviceUrl(userData) ??
                defaultClaudexServiceUrl,
            )
              .claudexRelease(linuxPackage, device)
              .then((release) => offerInterface(release.ui))
              .catch(() => {});
            return typeof version === "string" ? version : null;
          },
          ...(process.platform === "darwin"
            ? {
                unstage: () =>
                  clearShipItStage(os.homedir(), removeUserShipItJob),
              }
            : {}),
        })
      : new AppUpdater({
          userData,
          currentVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          linuxPackage,
          packaged: app.isPackaged,
          maxVersion: policy.maxVersion,
          disableAutoUpdates: policy.disableAutoUpdates,
          // Windows: an app pack applies over this install when it runs the
          // same Electron and has the same Codex files (app-pack.ts).
          ...(process.platform === "win32"
            ? {
                installed: async () => ({
                  runtime: process.versions.electron,
                  keep: await keepDigest(process.resourcesPath),
                }),
              }
            : {}),
          fetchRelease: async () => {
            const base =
              policy.updatesHost ??
              serviceUrl(userData) ??
              defaultClaudexServiceUrl;
            let locale: string | undefined;
            try {
              locale = preference(ctx.store.settings, "locale");
            } catch {
              /* Signed out. */
            }
            await ensureAppOwnership(locale);
            const release = await new Sub2ApiClient(base).claudexRelease(
              linuxPackage,
              device,
            );
            recordBinaryEndpoint(release.downloadUrl);
            // The same answer offers the interface pack (electron/ui-pack).
            offerInterface(release.ui);
            return release;
          },
          peekRelease: async () => {
            const base =
              policy.updatesHost ??
              serviceUrl(userData) ??
              defaultClaudexServiceUrl;
            const release = await new Sub2ApiClient(base).claudexRelease(
              linuxPackage,
              device,
            );
            recordBinaryEndpoint(release.downloadUrl);
            // Checking again with an update staged still offers the pack.
            offerInterface(release.ui);
            return release;
          },
          onStatus,
          onDownloaded,
        });
  updater.start();
  statusListeners.forEach((listener) => listener());
  const stealth = new StealthUpdate(() => {
    quitting = true;
    const win = ctx.appWindows.main();
    saveStealthWindow(userData, {
      visible: win?.isVisible() ?? false,
      minimized: win?.isMinimized() ?? false,
    });
    backgroundInstall = true;
    relaunchToUpdate();
  });
  const lifecycle = new UpdateLifecycle(
    policy,
    updateSession?.previousExitUnclean ?? false,
    launchedAt,
    (reason) => {
      quitting = true;
      log(`restarting to install update (${reason})`);
      const win = ctx.appWindows.main();
      if (
        reason === "unclean-exit" &&
        !BrowserWindow.getAllWindows().some((window) => window.isFocused())
      ) {
        saveStealthWindow(userData, {
          visible: win?.isVisible() ?? false,
          minimized: win?.isMinimized() ?? false,
        });
        backgroundInstall = true;
      }
      relaunchToUpdate();
    },
    log,
  );
  const reevaluate = () => {
    checkEarlyInstall();
    const current = updater;
    if (!current) return;
    const windows = BrowserWindow.getAllWindows();
    let busy = false;
    try {
      busy = ctx.engines.isBusy();
    } catch {
      /* No account yet. */
    }
    const staged = current.staged();
    const phase = current.status().phase;
    lifecycle.update({
      enabled: current.supported() && process.platform !== "linux",
      version: staged?.version,
      failed: (staged?.attempts ?? 0) > 0,
      busy,
      focused: windows.some((win) => win.isFocused()),
      fullScreen: windows.some((win) => win.isFullScreen()),
      idleSeconds: powerMonitor.getSystemIdleTime(),
      checking: phase === "checking" || phase === "downloading",
      windowReady:
        !!ctx.appWindows.main() && !ctx.appWindows.main()!.isDestroyed(),
      quitting,
    });
    stealth.update({
      enabled:
        !quitting &&
        current.supported() &&
        process.platform !== "linux" &&
        process.env.CLAUDEX_DISABLE_STEALTH_UPDATES !== "1",
      ready: !!staged,
      failed: (staged?.attempts ?? 0) >= 2,
      busy,
      focused: windows.some((win) => win.isFocused()),
      fullScreen: windows.some((win) => win.isFullScreen()),
      checking: phase === "checking" || phase === "downloading",
    });
  };
  onAppUpdateStatus(reevaluate);
  ctx.onEvent(reevaluate);
  app.on("browser-window-focus", reevaluate);
  app.on("browser-window-blur", reevaluate);
  app.on("browser-window-created", (_event, win) => {
    queueMicrotask(checkEarlyInstall);
    win.on("enter-full-screen", reevaluate);
    win.on("leave-full-screen", reevaluate);
  });
  const stealthTimer = setInterval(reevaluate, 1000);
  stealthTimer.unref();
  reevaluate();
  app.once("will-quit", () => clearInterval(stealthTimer));
  app.on("will-quit", () => {
    quitting = true;
    updater?.stop();
  });
  // Installed when Claudex quits, whether or not Relaunch was chosen.
  // The quit waits for the staged file's check and the helper's start, then
  // exits; the helper waits for this process to be gone.
  let installing = false;
  app.on("will-quit", (event) => {
    const current = updater;
    if (installing || !current?.supported()) return;
    // Linux asks for the system's authorization: only when Relaunch to
    // update was chosen, never at an ordinary quit.
    if (process.platform === "linux" && !relaunchAfterInstall) return;
    const staged = current.staged();
    if (!staged) return;
    installing = true;
    if (current instanceof NativeAppUpdater) {
      try {
        if (relaunchAfterInstall) {
          event.preventDefault();
          current.quitAndInstall();
          updateSession?.clean();
        } else current.recordInstallAttempt();
      } catch (error) {
        log("the native update couldn't be installed", error);
        updateSession?.clean();
        app.exit(0);
      }
      return;
    }
    event.preventDefault();
    const dir = updatesDir(userData);
    // Exits in any case: an install step that hangs can't hold Claudex open.
    const hold = setTimeout(() => app.exit(0), installHoldMs);
    void startInstall({
      dir,
      staged: readStaged(dir) ?? current.staged()!,
      relaunch: relaunchAfterInstall,
      pid: process.pid,
      execPath: process.execPath,
      background: backgroundInstall,
    })
      .catch((error) => {
        log("the update couldn't be installed", error);
        // Relaunch to update must not end with the app simply gone: it opens
        // again, and the staged update shows "Relaunch to retry update".
        if (relaunchAfterInstall) app.relaunch();
      })
      .finally(() => {
        clearTimeout(hold);
        updateSession?.clean();
        app.exit(0);
      });
  });
  return updater;
}

/**
 * Relaunch to update: quits (asking first when a task runs, unless the
 * window already asked: `interrupt`); the helper installs and reopens.
 */
export function relaunchToUpdate(options: { interrupt?: boolean } = {}) {
  if (!updater?.staged()) throw new Error("No update is ready to install.");
  relaunchAfterInstall = true;
  quitConfirmation.interrupt = options.interrupt === true;
  app.quit();
}

/**
 * The quit Relaunch to update started was called off (the running-task dialog's
 * Wait or Cancel): a later ordinary quit installs nothing and reopens nothing.
 */
export function cancelRelaunchToUpdate() {
  relaunchAfterInstall = false;
  quitConfirmation.interrupt = false;
}
