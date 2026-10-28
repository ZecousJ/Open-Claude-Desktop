import { hostedUiUrl, warmHostedUi } from "./hosted-ui";
import { uiPacksActive, uiPageUrl, watchUiWindow } from "../ui-pack/launch";
import { applyZoom } from "./window-zoom";
import { BrowserWindow } from "electron";
import path from "node:path";
import { type AppWindowRole } from "./app-context";
import { mainState } from "./main-state";
import {
  artifactPreviews,
  dirname,
  focusListeners,
  nonessentialServices,
  refreshNonessentialServices,
  appWindowRoles,
  sendTo,
} from "../main";

/**
 * Guards a renderer window like the main window, trusts its bridge calls and
 * sends it events until it closes.
 */
export function registerAppWindow(win: BrowserWindow, role: AppWindowRole) {
  const known = appWindowRoles.has(win);
  appWindowRoles.set(win, role);
  if (known) return;
  refreshNonessentialServices();
  nonessentialServices.add(win.webContents.session);
  // Links leave the app only after the renderer's confirmation: middle-clicked
  // reply links arrive here, preview links as frame navigations.
  const confirmExternal = (url: string) => {
    if (/^https?:\/\//.test(url)) sendTo(win, { type: "external-link", url });
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    confirmExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || artifactPreviews.has(event.url)) return;
    event.preventDefault();
    confirmExternal(event.url);
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-redirect", (event) => {
    const hosted = hostedUiUrl("index.html");
    if (
      hosted &&
      event.isMainFrame &&
      new URL(event.url).origin !== new URL(hosted).origin
    )
      event.preventDefault();
  });
  win.on("focus", () => focusListeners.emit());
  // Every app window shares the page zoom (and its traffic lights follow it).
  if (mainState.zoomLevel) applyZoom(win, mainState.zoomLevel);
  win.webContents.on("did-finish-load", () => {
    if (mainState.zoomLevel) applyZoom(win, mainState.zoomLevel);
  });
  // macOS hides the traffic lights in full screen: the window moves its toolbar
  // left. A reload while full screen is told again.
  const fullScreen = (active: boolean) =>
    sendTo(win, { type: "full-screen", active });
  win.on("enter-full-screen", () => fullScreen(true));
  win.on("leave-full-screen", () => fullScreen(false));
  win.webContents.on("did-finish-load", () => {
    if (win.isFullScreen()) fullScreen(true);
  });
  win.on("closed", () => appWindowRoles.delete(win));
}

/** Loads the renderer; `query` becomes the page's search string. */
export async function loadRenderer(
  win: BrowserWindow,
  query?: Record<string, string>,
) {
  const entries = Object.entries(query ?? {});
  if (process.env.CLAUDEX_DEV_URL) {
    if (!entries.length) return win.loadURL(process.env.CLAUDEX_DEV_URL);
    const url = new URL(process.env.CLAUDEX_DEV_URL);
    for (const [key, value] of entries) url.searchParams.set(key, value);
    return win.loadURL(url.toString());
  }
  const hosted = hostedUiUrl("index.html", query);
  if (hosted) {
    try {
      warmHostedUi(win.webContents.session, hosted);
    } catch (error) {
      console.error("[bootPreconnect] skipped", error);
    }
    try {
      return await win.loadURL(hosted);
    } catch (error) {
      console.error(
        "[hosted-ui] load failed, falling back to the local interface",
        error,
      );
    }
  }
  // A signed interface pack, or the installer's own, through claudex-app:
  // (electron/ui-pack); the plain files when the scheme is off or broken.
  if (uiPacksActive()) {
    watchUiWindow(win.webContents, (contents) => {
      const url = new URL(contents.getURL() || "claudex-app://ui/");
      void contents.loadFile(path.join(dirname, "../dist/index.html"), {
        query: Object.fromEntries(url.searchParams),
      });
    });
    return win.loadURL(
      uiPageUrl(
        "index.html",
        entries.length ? Object.fromEntries(entries) : undefined,
      ),
    );
  }
  return win.loadFile(
    path.join(dirname, "../dist/index.html"),
    entries.length ? { query: Object.fromEntries(entries) } : undefined,
  );
}
