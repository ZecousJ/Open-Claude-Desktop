/**
 * What `import … from "electron"` gives the desktop IPC handlers inside
 * claudex-runner (web plan §1, W-ARCH §1). The runner bundle maps "electron"
 * to this file (scripts/build-runner.mjs); the runner tests install the same
 * mapping with a module hook.
 *
 * Nothing here can reach a screen, a window or the runner host's desktop:
 * every Electron API throws `notAvailableOnWeb`. Handlers that would use one
 * are "absent" on the web and never registered (runner/src/dispatcher.ts);
 * the throw is the second line of defence. The few answers that remote
 * handlers do rely on are real:
 *
 * - `shell.openExternal(url)` opens the page in the calling user's browser
 *   tabs (an `open-url` link frame), e.g. a payment page from Billing;
 * - `safeStorage.isEncryptionAvailable()` is false, so provider keys stay in
 *   memory (the web key is never written to the runner's disk);
 * - `app.getVersion()` / `app.getName()` / `app.isPackaged`;
 * - `BrowserWindow.getFocusedWindow()` / `getAllWindows()` find no window;
 * - assigning `nativeTheme.themeSource` does nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import { isOpenableUrl } from "../../shared/web-protocol";

/** The bridge call the runner is running, as the shim needs it. */
export interface WebCallScope {
  userId: number;
  tabId?: string;
  /** Opens `url` in the user's tabs (the calling tab first). */
  openUrl(url: string): void;
}

/** Set by the dispatcher around every handler it runs. */
export const webCallScope = new AsyncLocalStorage<WebCallScope>();

/** The runner's version, reported by `app.getVersion()`. */
let runnerVersion = "0.0.0";
export function setShimVersion(version: string) {
  runnerVersion = version;
}

function refuse(): never {
  throw new Error(notAvailableOnWeb);
}

type Overrides = Record<PropertyKey, unknown>;

/**
 * A stand-in for an Electron module member: calling it, constructing it or
 * calling anything reached through it throws; `overrides` are real answers.
 */
const listenerMethods = new Set<PropertyKey>([
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "removeAllListeners",
]);

function unavailable(overrides: Overrides = {}): any {
  const target = function () {} as unknown as object;
  const proxy: any = new Proxy(target, {
    apply: refuse,
    construct: refuse,
    get(_target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop))
        return overrides[prop];
      // Not a thenable, not a primitive: awaiting or printing it is harmless.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "toJSON") return () => "[not available on the web]";
      // Listening for an app or system event is harmless: it never fires.
      if (listenerMethods.has(prop)) return () => proxy;
      return unavailable();
    },
    set(_target, prop) {
      // Only settings the web never reads may be assigned.
      return prop === "themeSource";
    },
    has(_target, prop) {
      return Object.prototype.hasOwnProperty.call(overrides, prop);
    },
  });
  return proxy;
}

async function openExternal(url: unknown) {
  const scope = webCallScope.getStore();
  if (!scope || typeof url !== "string") refuse();
  const text = new URL(url).href;
  if (!isOpenableUrl(text))
    throw new Error("Only secure (https) pages can be opened.");
  scope.openUrl(text);
}

export const app = unavailable({
  getVersion: () => runnerVersion,
  getName: () => "Claudex",
  isPackaged: false,
  isReady: () => true,
  // No app bundle: resources looked up under it (the computer-use driver on
  // macOS and Windows) are simply not found.
  getAppPath: () => "/nonexistent/claudex-runner-app",
});
export const shell = unavailable({ openExternal });
export const safeStorage = unavailable({
  isEncryptionAvailable: () => false,
});
export const BrowserWindow = unavailable({
  getFocusedWindow: () => null,
  getAllWindows: () => [],
});
export const nativeTheme = unavailable({
  shouldUseDarkColors: false,
  themeSource: "system",
});
export const BaseWindow = unavailable();
export const WebContentsView = unavailable();
export const Menu = unavailable();
export const MenuItem = unavailable();
export const Notification = unavailable({ isSupported: () => false });
export const Tray = unavailable();
export const clipboard = unavailable();
export const contextBridge = unavailable();
export const desktopCapturer = unavailable();
export const dialog = unavailable();
export const globalShortcut = unavailable();
export const ipcMain = unavailable();
export const ipcRenderer = unavailable();
export const nativeImage = unavailable();
export const net = unavailable();
export const autoUpdater = unavailable();
export const netLog = unavailable();
export const powerMonitor = unavailable();
export const powerSaveBlocker = unavailable();
export const protocol = unavailable();
export const screen = unavailable();
export const session = unavailable();
// Asked at registration on macOS (computer use): nothing is granted.
export const systemPreferences = unavailable({
  getMediaAccessStatus: () => "denied",
  isTrustedAccessibilityClient: () => false,
});
export const utilityProcess = unavailable();
export const webContents = unavailable();

const electron = {
  app,
  shell,
  safeStorage,
  BrowserWindow,
  nativeTheme,
  BaseWindow,
  WebContentsView,
  Menu,
  MenuItem,
  Notification,
  Tray,
  clipboard,
  contextBridge,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  ipcRenderer,
  nativeImage,
  net,
  netLog,
  autoUpdater,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  systemPreferences,
  utilityProcess,
  webContents,
};
export default electron;
