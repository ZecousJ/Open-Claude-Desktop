import { takeStealthWindow } from "../updates/stealth-window";
import { microphoneRequestAllowed } from "../voice/microphone-permission";
import { refreshAppMenu } from "./app-menu";
import { mainWindowTitle } from "./window-title";
import {
  mainWindowPlacement,
  minMainWindowSize,
  readMainWindowState,
  rememberZoomLevel,
  signInWindowSize,
  trackMainWindow,
} from "./main-window-state";
import { applyZoom } from "./window-zoom";
import {
  app,
  BrowserWindow,
  nativeTheme,
  screen,
  type WebContents,
} from "electron";
import { mainWindowChrome } from "./main-window-chrome";
import { mainState } from "./main-state";
import {
  artifactPreviews,
  artifactPopouts,
  mainWindowFile,
  integration,
  appWindowOf,
  appWindows,
  ctx,
} from "../main";
import { registerAppWindow, loadRenderer } from "./app-window-registry";

/** Zooms every app window to a level, remembers it and refreshes the menu. */
export function setZoomLevel(level: number) {
  mainState.zoomLevel = level;
  for (const win of appWindows.all()) applyZoom(win, level);
  rememberZoomLevel(mainWindowFile(), level);
  refreshAppMenu();
}

/** The work areas of the connected displays, the primary one first. */
function workAreas() {
  const primary = screen.getPrimaryDisplay();
  return [
    primary.workArea,
    ...screen
      .getAllDisplays()
      .filter((display) => display.id !== primary.id)
      .map((display) => display.workArea),
  ];
}

/** Brings the main window back from hidden or minimized, creating it if it is gone. */
export async function showMainWindow() {
  // During startup the startup sequence creates the window itself (with any
  // pending link); the dock, a second launch or a link only wait for it.
  if (!mainState.started) return;
  if (!mainState.window || mainState.window.isDestroyed()) {
    await createWindow();
    return;
  }
  if (mainState.window.isMinimized()) mainState.window.restore();
  mainState.window.show();
  mainState.window.focus();
}

/**
 * The main window is the sign-in window (600 x 600, centred) while nobody is
 * signed in, and goes back to its remembered size afterwards (the original
 * switches between its sign-in window and the app window; source: desktop
 * bundle 2.31226.1 static JS). A maximized or full-screen window stays.
 */
export function shapeMainWindow(signedIn: boolean) {
  const win = mainState.window;
  if (!win || win.isDestroyed()) return;
  if (!signedIn && !mainState.signInShape) {
    if (win.isMaximized() || win.isFullScreen()) return;
    mainState.boundsBeforeSignIn = win.getBounds();
    mainState.signInShape = true;
    const area = screen.getDisplayMatching(
      mainState.boundsBeforeSignIn,
    ).workArea;
    win.setBounds(
      {
        x: Math.round(area.x + (area.width - signInWindowSize.width) / 2),
        y: Math.round(area.y + (area.height - signInWindowSize.height) / 2),
        ...signInWindowSize,
      },
      true,
    );
  } else if (signedIn && mainState.signInShape) {
    mainState.signInShape = false;
    if (mainState.boundsBeforeSignIn)
      win.setBounds(mainState.boundsBeforeSignIn, true);
    mainState.boundsBeforeSignIn = undefined;
  }
}

export async function createWindow() {
  const stealthWindow = takeStealthWindow(app.getPath("userData"));
  const saved = readMainWindowState(mainWindowFile());
  if (saved?.zoomLevel !== undefined && !mainState.zoomLevel)
    mainState.zoomLevel = saved.zoomLevel;
  const win = new BrowserWindow({
    ...mainWindowPlacement(saved, workAreas()),
    ...(stealthWindow ? { show: false } : {}),
    // The original's window narrows to ~600.
    minWidth: minMainWindowSize.width,
    minHeight: minMainWindowSize.height,
    title: "Claudex",
    // The 2.37337.1 window colours (TBn), shown before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151515" : "#fcfcfb",
    ...mainWindowChrome(
      process.platform,
      mainState.zoomLevel,
      nativeTheme.shouldUseDarkColors,
    ),
    webPreferences: appWindows.webPreferences(),
  });
  mainState.window = win;
  // The title follows the open conversation (electron/window-title.ts).
  mainState.window.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const next = mainWindowTitle(title);
    if (
      mainState.window &&
      !mainState.window.isDestroyed() &&
      mainState.window.getTitle() !== next
    )
      mainState.window.setTitle(next);
  });
  if (saved?.maximized) mainState.window.maximize();
  if (saved?.fullScreen) mainState.window.setFullScreen(true);
  trackMainWindow(
    mainState.window,
    mainWindowFile(),
    () => mainState.zoomLevel,
    () => !mainState.signInShape,
  );
  // Nobody is signed in yet: the window starts as the sign-in window.
  if (!mainState.activeAccount) shapeMainWindow(false);
  // Link confirmation, navigation guards, focus and trust (registerAppWindow).
  registerAppWindow(mainState.window, { kind: "main" });
  mainState.window.on("closed", () => {
    artifactPopouts.closeAll();
    artifactPreviews.clear();
    appWindows.closeConversationWindows();
  });
  // Any app window's own page may record (a separate window dictates too).
  const appPage = (requester: WebContents | null) =>
    appWindowOf(requester) || mainState.quickEntry?.owns(requester)
      ? requester!
      : undefined;
  mainState.window.webContents.session.setPermissionRequestHandler(
    (requester, permission, callback, details) => {
      const media = "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(
        permission === "media" &&
          microphoneRequestAllowed(
            ctx,
            mainState.policyHost?.current().voice ?? false,
            {
              requesterIsMainWindow: Boolean(appWindowOf(requester)),
              requesterIsQuickEntry: mainState.quickEntry?.owns(requester),
              isMainFrame: details.isMainFrame,
              requestingUrl: details.requestingUrl,
              mainUrl: appPage(requester)?.getURL() ?? "",
              mediaTypes: media,
            },
          ),
      );
    },
  );
  mainState.window.webContents.session.setPermissionCheckHandler(
    (requester, permission, _origin, details) =>
      permission === "media" &&
      microphoneRequestAllowed(
        ctx,
        mainState.policyHost?.current().voice ?? false,
        {
          requesterIsMainWindow: Boolean(appWindowOf(requester)),
          requesterIsQuickEntry: mainState.quickEntry?.owns(requester),
          isMainFrame: details.isMainFrame,
          requestingUrl: details.requestingUrl,
          mainUrl: appPage(requester)?.getURL() ?? "",
          mediaTypes: details.mediaType ? [details.mediaType] : undefined,
        },
      ),
  );
  // Closing the window hides it and keeps the app (its tasks, tray icon and
  // Quick Entry) running, as the original does (off macOS only while the
  // tray icon shows; without it closing quits); Quit, the tray's Quit and an
  // update restart really close it, and the dock icon or a second launch
  // brings it back. A full-screen window leaves full screen first.
  // Windows closes the windows without a before-quit when the session ends.
  mainState.window.on("session-end", () => {
    mainState.quitting = true;
  });
  win.on("close", (event) => {
    if (mainState.quitting) return;
    // Only the current main window hides; any other (a stray earlier one)
    // just closes. Each acts on itself, never on whichever window is newest.
    if (win !== mainState.window) return;
    event.preventDefault();
    // Windows and Linux without the tray icon: nothing would bring a hidden
    // window back, so closing quits (before-quit still asks about a running
    // task). Users had to end Claudex in Task Manager.
    if (process.platform !== "darwin" && !integration.hasTray()) {
      app.quit();
      return;
    }
    if (win.isFullScreen()) {
      win.once("leave-full-screen", () => win.hide());
      win.setFullScreen(false);
    } else win.hide();
  });
  const connector = mainState.pendingConnectorLink;
  mainState.pendingConnectorLink = undefined;
  const deepLink = mainState.activeAccount
    ? mainState.pendingDeepLink
    : undefined;
  mainState.pendingDeepLink = undefined;
  const emailLink = !mainState.activeAccount
    ? mainState.pendingEmailLink
    : undefined;
  mainState.pendingEmailLink = undefined;
  await loadRenderer(
    mainState.window,
    emailLink
      ? { "email-link": emailLink }
      : connector
        ? { connector }
        : deepLink
          ? { deeplink: deepLink }
          : undefined,
  );
  if (stealthWindow?.minimized) mainState.window.minimize();
  else if (stealthWindow?.visible) mainState.window.showInactive();
}
