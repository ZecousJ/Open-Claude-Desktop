import { bindStagedDocument, stagedDocumentCurrent } from "./staged-document-lease";
import { OfficialWindowCreationCancelled } from "../official-ui/staged-window";
import { createOfficialWindow, officialAppWindows, notifyOfficialZoomChanged, officialUiEnabled, isRetiredOfficialWindow, openOfficialDeepLink, showOfficialRecoveryWindow } from "../official-ui/window";
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
  type Rectangle,
  type WebContents,
} from "electron";
import { mainWindowChrome } from "./main-window-chrome";
import { waitForSignIn } from "./sign-in-handoff";
import { mainState } from "./main-state";
import {
  artifactPreviews,
  artifactPopouts,
  mainWindowFile,
  integration,
  appWindowOf,
  appWindows,
  appWindowRoles,
  sendTo,
  ctx,
} from "../main";
import { registerAppWindow, loadRenderer } from "./app-window-registry";

const classicRecoveryWindows = new WeakSet<BrowserWindow>();

export function bindPendingDeepLink() {
  const pending = mainState.pendingDeepLink;
  const activation = mainState.accountRetirement.accountActivationIdentity;
  if (!pending || !mainState.activeAccount || mainState.accountRetirement.accountRetiring) return;
  pending.activation ??= activation;
  if (pending.activation === activation) return pending;
  mainState.pendingDeepLink = undefined;
}

export async function deliverPendingDeepLink() {
  const win = mainState.window;
  const pending = bindPendingDeepLink();
  if (!win || win.isDestroyed() || !pending) return;
  const take = () => {
    if (mainState.window !== win || win.isDestroyed() || bindPendingDeepLink() !== pending)
      return false;
    mainState.pendingDeepLink = undefined;
    return true;
  };
  if (await openOfficialDeepLink(win, pending.link, take)) return;
  if (officialUiEnabled() && !classicRecoveryWindows.has(win)) return;
  if (stagedDocumentCurrent(win) && take())
    sendTo(win, { type: "deep-link", link: pending.link });
}

/** Zooms every app window to a level, remembers it and refreshes the menu. */
export function setZoomLevel(level: number) {
  mainState.zoomLevel = level;
  const official = officialAppWindows();
  for (const win of new Set([...appWindows.all(), ...official]))
    applyZoom(win, level);
  for (const win of official) notifyOfficialZoomChanged(win);
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
  if (isRetiredOfficialWindow(mainState.window)) {
    await showOfficialRecoveryWindow();
    return;
  }
  if (!mainState.window || mainState.window.isDestroyed()) {
    if (officialUiEnabled() && mainState.activeAccount) await createOfficialWindow();
    else await createWindow();
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
    win.setBounds(signInBounds(mainState.boundsBeforeSignIn), true);
  } else if (signedIn && mainState.signInShape) {
    mainState.signInShape = false;
    if (mainState.boundsBeforeSignIn)
      win.setBounds(mainState.boundsBeforeSignIn, true);
    mainState.boundsBeforeSignIn = undefined;
  }
}

function signInBounds(previous: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(previous).workArea;
  return {
    x: Math.round(area.x + (area.width - signInWindowSize.width) / 2),
    y: Math.round(area.y + (area.height - signInWindowSize.height) / 2),
    ...signInWindowSize,
  };
}

export async function createWindow(options: { stage?: { current(): boolean } } = {}) {
  const previousMain = mainState.window;
  const documentStore = mainState.store;
  const documentAccount = mainState.activeAccount?.id;
  const officialSignIn = !documentAccount && officialUiEnabled();
  const documentGeneration = mainState.accountRetirement?.accountActivationIdentity;
  const documentCurrent = () => documentGeneration != null && mainState.store === documentStore &&
    mainState.activeAccount?.id === documentAccount &&
    mainState.accountRetirement?.accountActivationIdentity === documentGeneration;
  let committed = !options.stage;
  const checkStage = () => {
    if (options.stage && (!options.stage.current() || !documentCurrent() || mainState.window !== previousMain))
      throw new OfficialWindowCreationCancelled();
  };
  checkStage();
  const stealthWindow = options.stage ? undefined : takeStealthWindow(app.getPath("userData"));
  const saved = readMainWindowState(mainWindowFile());
  if (saved?.zoomLevel !== undefined && !mainState.zoomLevel)
    mainState.zoomLevel = saved.zoomLevel;
  const win = new BrowserWindow({
    ...mainWindowPlacement(saved, workAreas()),
    ...(stealthWindow || options.stage ? { show: false } : {}),
    // W602 captures (R-0114, R-0315 …): the original's window narrows to ~600.
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
  const signInRestoreBounds = options.stage && !documentAccount && !saved?.maximized && !saved?.fullScreen
    ? win.getBounds() : undefined;
  if (signInRestoreBounds) win.setBounds(signInBounds(signInRestoreBounds), false);
  const revokeDocument = options.stage ? bindStagedDocument(win, () => documentCurrent() &&
    (committed || (options.stage!.current() && mainState.window === previousMain))) : undefined;
  if (revokeDocument) win.once("closed", revokeDocument);
  try {
  if (!options.stage) mainState.window = win;
  // The title follows the open conversation (electron/window-title.ts).
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const next = mainWindowTitle(title);
    if (
      !win.isDestroyed() && win.getTitle() !== next
    ) win.setTitle(next);
  });
  if (!options.stage && saved?.maximized) win.maximize();
  if (!options.stage && saved?.fullScreen) win.setFullScreen(true);
  trackMainWindow(
    win,
    mainWindowFile(),
    () => mainState.zoomLevel,
    () => committed && !mainState.signInShape,
  );
  // Nobody is signed in yet: the window starts as the sign-in window.
  if (!options.stage && !mainState.activeAccount) shapeMainWindow(false);
  // Link confirmation, navigation guards, focus and trust (registerAppWindow).
  registerAppWindow(win, { kind: "main" });
  win.on("closed", () => {
    if (mainState.window !== win) return;
    artifactPopouts.closeAll();
    artifactPreviews.clear();
    appWindows.closeConversationWindows();
  });
  // Any app window's own page may record (a separate window dictates too).
  const appPage = (requester: WebContents | null) =>
    appWindowOf(requester) || mainState.quickEntry?.owns(requester)
      ? requester!
      : undefined;
  win.webContents.session.setPermissionRequestHandler(
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
  win.webContents.session.setPermissionCheckHandler(
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
  win.on("session-end", () => {
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
    // task). Users had to end Claudex in Task Manager (owner, 2026-10-14).
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
  if (!options.stage) mainState.pendingConnectorLink = undefined;
  const deepLink = bindPendingDeepLink();
  const emailLink = !mainState.activeAccount
    ? mainState.pendingEmailLink
    : undefined;
  if (!options.stage) mainState.pendingEmailLink = undefined;
  const query: Record<string, string> | undefined = emailLink
      ? { "email-link": emailLink }
      : connector
        ? { connector }
        : deepLink
          ? { deeplink: deepLink.href }
          : undefined;
  await loadRenderer(win, officialSignIn ? { ...query, "official-sign-in": "1" } : query);
  if (options.stage && !documentAccount) {
    checkStage();
    await waitForSignIn(win.webContents);
  }
  if (options.stage) {
    checkStage();
    if (!stagedDocumentCurrent(win)) throw new OfficialWindowCreationCancelled();
    if (win.isDestroyed()) throw new Error("The recovery window closed before loading.");
    mainState.window = win;
    committed = true;
    if (emailLink && mainState.pendingEmailLink === emailLink) mainState.pendingEmailLink = undefined;
    else if (connector && mainState.pendingConnectorLink === connector) mainState.pendingConnectorLink = undefined;
    classicRecoveryWindows.add(win);
    if (saved?.maximized) win.maximize();
    if (saved?.fullScreen) win.setFullScreen(true);
    mainState.signInShape = !!signInRestoreBounds;
    mainState.boundsBeforeSignIn = signInRestoreBounds;
    win.show();
    if (previousMain && isRetiredOfficialWindow(previousMain)) previousMain.hide();
  }
  if (!emailLink && !connector && deepLink && mainState.pendingDeepLink === deepLink)
    mainState.pendingDeepLink = undefined;
  if (stealthWindow?.minimized) win.minimize();
  else if (stealthWindow?.visible) win.showInactive();
  return win;
  } catch (error) {
    if (options.stage && !committed) {
      revokeDocument?.();
      appWindowRoles.delete(win);
      if (!win.isDestroyed()) win.destroy();
    }
    throw error;
  }
}
