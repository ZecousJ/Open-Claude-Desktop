import { defaultClaudexServiceUrl } from "../../shared/claudex-service";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  webContents,
  type BaseWindow,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppCommand } from "../../shared/types";
import {
  automaticUpdateNotice,
  updateCheckResult,
} from "../../shared/client-release";
import { downloadPage, httpsPage } from "../../shared/external-links";
import type { AppContext } from "./app-context";
import { appMenuTemplate, type AppMenuOptions } from "./app-menu-template";
import type { IntegrationWindows } from "./desktop-integration";
import {
  packagedBuildDate,
  packagedCommitHash,
  showAboutWindow,
} from "./about-window";
import { clearWebCaches } from "../support/clear-cache";
import { routeEditCommand } from "./edit-commands";
import {
  copyInstallationId,
  generateDiagnosticReport,
  hardwareAccelerationDisabled,
  recordNetLog,
  resetAppData,
  setHardwareAccelerationDisabled,
} from "../support/troubleshooting";
import {
  developerModeAllowed,
  developerToolsAllowed,
  enableDeveloperSettings,
} from "../store/developer-settings";
import { nativeTranslator } from "./native-i18n";
import { preference } from "../../shared/settings-extras";
import {
  menuState,
  onMenuState,
  onViewedConversations,
  viewedConversations,
} from "./menu-state";
import { updateMenuItem } from "../../shared/app-update";
import type { AppUpdateStatus } from "../../shared/app-update-api";
import {
  appUpdater,
  onAppUpdateStatus,
  relaunchToUpdate,
} from "../updates/launch";
import { runUpdateMenuAction } from "../updates/menu-action";

/** Set by `connectAppMenu` (IPC registration) and `installAppMenu` (start-up). */
let context: AppContext | undefined;
let runCommand: ((command: AppCommand) => void) | undefined;
/** Edit ▸ Find… and its siblings (find-in-page-main.ts). */
let findActions: AppMenuOptions["find"];
/** The help page the installed menu links to, to rebuild only on a change. */
let installedHelp: string | undefined;
let installedDeveloperMode: boolean | undefined;
let installedLocale: string | undefined;
let translate = (text: string) => text;
/** The updates item's label in the installed menu (and whether a failure line shows). */
let installedUpdateLabel: string | undefined;
let installedUpdateFailed: boolean | undefined;
/** View ▸ Zoom In, Zoom Out and Actual Size (main.ts applies the zoom to every window). */
let zoomActions: AppMenuOptions["zoom"];

/**
 * The menu's language: the signed-in account's setting; signed out there is no
 * store, so English.
 */
export function menuLocale() {
  const store = context?.store;
  return store ? preference(store.settings, "locale") : "en-US";
}

/**
 * Gives the menu the signed-in account's policy: Check for Updates reads its
 * release information and Help links to the administrator's help page.
 */
export function connectAppMenu(ctx: AppContext) {
  context = ctx;
  // Notifications open their conversation where it is shown (R2).
  ctx.integration.connectWindows(appWindowTargets(ctx));
  // Opening a session (or bringing its window forward) takes its banners away.
  onViewedConversations(() => ctx.integration.observeViewing());
  ctx.onWindowFocus(() => ctx.integration.observeViewing());
  // Signing in or out sends no event of its own: a policy event, any later
  // event or the window's focus brings Help up to date (rebuilt only when
  // its page changed).
  ctx.onEvent(rebuild);
  ctx.onWindowFocus(rebuild);
}

/**
 * The main window and the conversation windows as the menu and the system
 * integration reach them: a conversation with its own window is focused
 * there; anything else opens in the main window.
 */
export function appWindowTargets(
  ctx: Pick<AppContext, "appWindows" | "services">,
): IntegrationWindows {
  return {
    focusConversation: (id) =>
      ctx.services.chatWindows?.focusConversation(id) ?? false,
    showMain: (conversationId) => {
      const main = ctx.appWindows.main();
      if (!main) return false;
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      // The window checks the conversation is still its account's own.
      if (conversationId)
        ctx.appWindows.send(main, {
          type: "command",
          command: "open-conversation",
          conversationId,
        });
      return true;
    },
    // The window in front shows the conversation: its own window, or the
    // main window with it open (alone or in the split view).
    viewing: (conversationId) => {
      const focused = ctx.appWindows.focused();
      if (
        !focused ||
        focused.isDestroyed() ||
        !focused.isVisible() ||
        focused.isMinimized()
      )
        return false;
      const own = ctx.services.chatWindows?.conversationOf?.(focused);
      if (own !== undefined) return own === conversationId;
      return (
        focused === ctx.appWindows.main() &&
        viewedConversations().includes(conversationId)
      );
    },
  };
}

/** The application menu (see app-menu-template.ts). */
export function installAppMenu(
  run: (command: AppCommand) => void,
  find?: AppMenuOptions["find"],
  zoom?: AppMenuOptions["zoom"],
) {
  runCommand = run;
  findActions = find;
  zoomActions = zoom;
  build();
  // The updates item follows the updater (checking, downloading, ready).
  onAppUpdateStatus(rebuild);
  // Item names and states follow the main window's report.
  onMenuState(build);
  app.on("browser-window-focus", build);
  app.on("browser-window-blur", build);
  app.on("browser-window-created", (_event, window) => {
    window.on("enter-full-screen", build);
    window.on("leave-full-screen", build);
  });
  for (const window of BrowserWindow.getAllWindows()) {
    window.on("enter-full-screen", build);
    window.on("leave-full-screen", build);
  }
}

/** Rebuilds the menu now (the zoom level changed: Actual Size's state). */
export function refreshAppMenu() {
  build();
}

/** The app icon as a data address for the About window, when the file is there. */
function aboutIcon() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, "about-icon.png")
    : path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../build/icon.iconset/icon_128x128@2x.png",
      );
  try {
    return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return undefined;
  }
}

const updateStatus = () => appUpdater()?.status();

function helpPage() {
  try {
    // Opened by the main process directly, so only a plain https page.
    return context?.activeAccount
      ? httpsPage(context.policy().links.help)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Help and Get Support: the administrator's help page, else the service's help. */
function openHelp() {
  const page =
    helpPage() ??
    (context?.remote?.accounts.baseUrl
      ? new URL("/help", context.remote.accounts.baseUrl).href
      : defaultClaudexServiceUrl
        ? new URL("/help", defaultClaudexServiceUrl).href
        : undefined);
  if (page) void shell.openExternal(page).catch(() => {});
}

function developerSettingsPath() {
  return path.join(app.getPath("userData"), "developer_settings.json");
}

function allowDeveloperMode() {
  return !!context && developerModeAllowed(context.policy());
}

async function enableDeveloperMode() {
  const locale = menuLocale();
  await enableDeveloperSettings({
    file: developerSettingsPath(),
    allowed: allowDeveloperMode,
    translate: await nativeTranslator(locale),
    showMessageBox: (options) => dialog.showMessageBox(options),
    restart: () => {
      app.relaunch();
      app.quit();
    },
  });
}

function build() {
  if (!runCommand) return;
  installedDeveloperMode = allowDeveloperMode();
  const locale = menuLocale();
  if (locale !== installedLocale) {
    installedLocale = locale;
    void nativeTranslator(locale)
      .then((next) => {
        if (installedLocale !== locale) return;
        translate = next;
        build();
      })
      .catch(console.error);
  }
  installedHelp = helpPage();
  const updateItem = updateMenuItem(
    updateStatus(),
    appUpdater()?.menuVisible() ?? false,
  );
  installedUpdateLabel = updateItem?.label;
  installedUpdateFailed = updateItem?.failed;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        editCommand: routeEditCommand,
        mac: process.platform === "darwin",
        appName: app.name,
        run: runCommand,
        checkForUpdates: () =>
          void runUpdateMenuAction({
            status: updateStatus(),
            restart: () => relaunchToUpdate(),
            check: checkForUpdates,
          }),
        showMainWindow: () => {
          if (context) appWindowTargets(context).showMain();
        },
        state:
          !context ||
          BrowserWindow.getFocusedWindow() === context.appWindows.main()
            ? menuState()
            : { ...menuState(), closeTarget: undefined, findInFiles: false },
        translate,
        fullScreen: BrowserWindow.getFocusedWindow()?.isFullScreen() ?? false,
        updateItem,
        zoom: zoomActions,
        openHelp,
        // Help ▸ Troubleshooting and About (Windows and Linux).
        showLogs: () => void shell.openPath(app.getPath("logs")),
        clearCacheAndRestart: () => void clearCacheAndRestart().catch(() => {}),
        troubleshooting: {
          copyInstallationId,
          generateDiagnosticReport: () => {
            const window =
              context?.appWindows.focused() ?? context?.appWindows.main();
            if (window)
              context?.appWindows.send(window, {
                type: "support-bundle-requested",
              });
            else void generateDiagnosticReport().catch(() => {});
          },
          recordNetLog: (window) => void recordNetLog(window).catch(() => {}),
          hardwareAccelerationDisabled: hardwareAccelerationDisabled(),
          setHardwareAccelerationDisabled: (disabled) =>
            void setHardwareAccelerationDisabled(disabled, translate, () => {
              app.relaunch();
              app.quit();
            })
              .then(() => build())
              .catch(() => {}),
          resetAppData: () => void resetAppData(translate).catch(() => {}),
        },
        enableDeveloperMode:
          allowDeveloperMode() &&
          !developerToolsAllowed(developerSettingsPath(), context!.policy())
            ? () => void enableDeveloperMode()
            : undefined,
        developerModeLabel: translate("Enable Developer Mode…"),
        developerTools:
          context &&
          developerToolsAllowed(developerSettingsPath(), context.policy())
            ? {
                label: translate("Developer"),
                openLabel: translate("Show Dev Tools"),
                openAllLabel: translate("Show All Dev Tools"),
                open: () => {
                  if (
                    context &&
                    developerToolsAllowed(
                      developerSettingsPath(),
                      context.policy(),
                    )
                  )
                    webContents
                      .getFocusedWebContents()
                      ?.openDevTools({ mode: "undocked" });
                },
                openAll: () => {
                  if (
                    !context ||
                    !developerToolsAllowed(
                      developerSettingsPath(),
                      context.policy(),
                    )
                  )
                    return;
                  for (const window of BrowserWindow.getAllWindows())
                    window.webContents.openDevTools({ mode: "undocked" });
                },
              }
            : undefined,
        about: () =>
          showAboutWindow({
            name: app.name,
            version: app.getVersion(),
            commitHash: packagedCommitHash(),
            buildDate: packagedBuildDate(),
            locale,
            translate,
            icon: aboutIcon(),
            openHelp: helpPage() ? openHelp : undefined,
          }),
        find: findActions,
        reload: (window) => void reloadFocused(window),
      }),
    ),
  );
}

/** The renderer's answer about the Browser panel's focus, at most this long. */
const focusQueryMs = 250;
/** Marks the Browser panel of a conversation (src/browser/BrowserPanel.tsx). */
const browserPanelQuery =
  'document.activeElement?.closest?.("[data-browser-conversation]")?.getAttribute("data-browser-conversation") ?? ""';

/**
 * View ▸ Reload: the Browser's page when it or the Browser panel around it
 * (address bar, tabs) has the keyboard focus, else the window. A window that
 * does not answer in time is reloaded.
 */
export async function reloadFocused(window?: BaseWindow) {
  const browser = context?.services.browser;
  const page = browser?.host.focusedConversation();
  if (browser && page) return browser.host.reload(page);
  const target =
    window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
  const contents = target?.webContents;
  if (!contents || contents.isDestroyed()) return;
  if (browser && !contents.isCrashed()) {
    const answer = await Promise.race([
      contents
        .executeJavaScript(browserPanelQuery)
        .then((value: unknown) => (typeof value === "string" ? value : ""))
        .catch(() => ""),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(""), focusQueryMs),
      ),
    ]);
    if (answer && browser.host.has(answer)) return browser.host.reload(answer);
  }
  if (!contents.isDestroyed()) contents.reload();
}

/** Help ▸ Troubleshooting ▸ Clear Cache and Restart: web caches only, never the account's data. */
async function clearCacheAndRestart() {
  // The same caches as Settings → Storage → Clear cache and restart….
  const session = context?.window?.webContents.session;
  if (session) await clearWebCaches(session);
  app.relaunch();
  app.quit();
}

function rebuild() {
  const item = updateMenuItem(
    updateStatus(),
    appUpdater()?.menuVisible() ?? false,
  );
  if (
    helpPage() !== installedHelp ||
    allowDeveloperMode() !== installedDeveloperMode ||
    menuLocale() !== installedLocale ||
    item?.label !== installedUpdateLabel ||
    item?.failed !== installedUpdateFailed
  )
    build();
}

/** Asks the service again and waits briefly for a newer policy. */
function refreshed(ctx: AppContext, waitMs = 1500) {
  return new Promise<void>((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => done(), waitMs);
    const done = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    off = ctx.onEvent((event) => {
      if (event.type === "policy") done();
    });
    ctx.refreshPolicy();
  });
}

/** Starts a check and waits until it has an answer to show (not "checking"). */
function settled(): Promise<AppUpdateStatus> {
  const updater = appUpdater()!;
  return new Promise((resolve) => {
    let off = () => {};
    const done = () => {
      const status = updater.status();
      if (status.phase === "checking") return;
      off();
      resolve(status);
    };
    off = onAppUpdateStatus(done);
    void updater.check({ manual: true }).then(done);
  });
}

type ShowMessage = (
  options: Electron.MessageBoxOptions,
) => Promise<Electron.MessageBoxReturnValue>;

/** Check for Updates… while Claudex updates itself. */
async function checkWithUpdater(show: ShowMessage) {
  const current = appUpdater()!.status();
  const status =
    current.phase === "ready" || current.phase === "downloading"
      ? current
      : await settled();
  if (status.phase === "ready" || status.phase === "downloading") {
    await show({
      type: "info",
      ...automaticUpdateNotice,
    });
    return;
  }
  if (status.phase !== "error") {
    await show({
      type: "info",
      message: "No Update Available",
      detail: "You are running the latest version.",
      buttons: ["OK"],
    });
    return;
  }
  // The service's download page, when it has one, is the way out.
  const page = context?.activeAccount
    ? downloadPage(context.policy().update)
    : undefined;
  const buttons = page ? ["Download", "OK"] : ["OK"];
  const { response } = await show({
    type: "warning",
    message: status.version
      ? `Claudex ${status.version} couldn't be installed`
      : "Couldn't check for updates",
    detail: status.error ?? "",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (page && response === 0) await shell.openExternal(page);
}

async function checkForUpdates() {
  const ctx = context;
  const window =
    ctx?.window && !ctx.window.isDestroyed() ? ctx.window : undefined;
  const translate = await nativeTranslator(menuLocale());
  const show: ShowMessage = (options) => {
    const translated = {
      ...options,
      ...(options.title ? { title: translate(options.title) } : {}),
      message: translate(options.message),
      ...(options.detail ? { detail: translate(options.detail) } : {}),
      buttons: options.buttons?.map(translate),
    };
    return window
      ? dialog.showMessageBox(window, translated)
      : dialog.showMessageBox(translated);
  };
  if (appUpdater()?.supported()) {
    await checkWithUpdater(show);
    return;
  }
  if (!ctx?.activeAccount) {
    await show({
      type: "info",
      message: "Sign in to check for updates",
      detail: "Claudex gets its release information from your service.",
      buttons: ["OK"],
    });
    return;
  }
  await refreshed(ctx);
  const update = ctx.policy().update;
  const result = updateCheckResult(update, ctx.appVersion);
  const page = update && downloadPage(update);
  const buttons = page ? ["Download", "Later"] : ["OK"];
  const { response } = await show({
    type: "info",
    message: result.title,
    detail: result.detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (page && response === 0) await shell.openExternal(page);
}
