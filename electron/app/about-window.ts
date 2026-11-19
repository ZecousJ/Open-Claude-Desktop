import electron from "electron";
import type { BrowserWindow } from "electron";
import { uiScheme } from "../../shared/ui-pack";
import {
  aboutActions,
  aboutPage,
  aboutVersionText,
  aboutWindowSize,
  copiedAboutVersionText,
} from "./about-page";

export interface AboutWindowOptions {
  name: string;
  version: string;
  commitHash?: string;
  channel?: "latest";
  /** The packaged build timestamp shown under the version. */
  buildDate?: Date;
  locale?: string;
  translate?: (text: string) => string;
  /** A data: address for the app icon, when the file is there. */
  icon?: string;
  openHelp: () => void;
}

declare const __CLAUDEX_BUILD_TIMESTAMP__: string | undefined;
declare const __CLAUDEX_COMMIT_HASH__: string | undefined;

let open: BrowserWindow | undefined;

export function packagedBuildDate() {
  const date =
    typeof __CLAUDEX_BUILD_TIMESTAMP__ === "string"
      ? new Date(__CLAUDEX_BUILD_TIMESTAMP__)
      : undefined;
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

export function packagedCommitHash() {
  return typeof __CLAUDEX_COMMIT_HASH__ === "string"
    ? __CLAUDEX_COMMIT_HASH__
    : undefined;
}

/** Shows the About window, or brings the open one forward. */
export function showAboutWindow(options: AboutWindowOptions) {
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    return;
  }
  const { BrowserWindow, clipboard, nativeTheme, session } = electron;
  const translate = options.translate ?? ((text: string) => text);
  const version = aboutVersionText(
    options.version,
    options.commitHash,
    options.channel,
  );
  const copiedLabel = JSON.stringify(translate("Copied version to clipboard"));
  const versionLabel = JSON.stringify(
    translate("Version {version}").replace("{version}", version),
  );
  const html = aboutPage({
    name: options.name,
    version: options.version,
    commitHash: options.commitHash,
    channel: options.channel,
    buildDate: options.buildDate,
    locale: options.locale,
    translate,
    icon: options.icon,
    platform: process.platform,
  });
  const url = `${uiScheme}://about/index.html`;
  const aboutSession = session.fromPartition("about-window");
  aboutSession.protocol.handle(uiScheme, (request) =>
    request.url === url
      ? new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      : new Response(null, { status: 404 }),
  );
  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    ...aboutWindowSize,
    useContentSize: true,
    title: translate("About {appName}").replace("{appName}", options.name),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151515" : "#fcfcfb",
    ...(mac ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      session: aboutSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  open = win;
  win.removeMenu();
  win.on("closed", () => {
    aboutSession.protocol.unhandle(uiScheme);
    if (open === win) open = undefined;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-navigate-in-page", (_event, url) => {
    const action = new URL(url).hash;
    if (!action) return;
    void win.webContents
      .executeJavaScript('location.hash = ""')
      .catch(() => {});
    if (action === aboutActions.copy) {
      clipboard.writeText(
        copiedAboutVersionText(options.name, version, options.buildDate),
      );
      // The original announces the copy result through an sr-only status.
      void win.webContents
        .executeJavaScript(
          `(() => { const link = document.getElementById("version"); const status = document.getElementById("copy-status"); if (link) link.textContent = ${copiedLabel}; if (status) status.textContent = ${copiedLabel}; setTimeout(() => { if (link) link.textContent = ${versionLabel}; if (status) status.textContent = ""; }, 2000); })()`,
        )
        .catch(() => {});
    } else if (
      action === aboutActions.help ||
      action === aboutActions.support
    ) {
      options.openHelp();
    }
  });
  void win.loadURL(url);
}
