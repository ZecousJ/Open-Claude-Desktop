/**
 * Interface packs in the running app (docs/releasing.md):
 *
 * - The windows load `claudex-app://ui/<version>/<page>`: `<version>` is a
 *   verified pack under `<userData>/ui-packs/` or `bundled` (the installer's
 *   own `dist/`). The version is part of the address, so a window keeps
 *   loading its own lazy chunks while another version is installed.
 * - The service's release information offers a pack; it is downloaded,
 *   checked against its SHA-256 and the release key's signature, and
 *   becomes the target.
 * - The target is switched to at launch, or while nothing runs and nobody
 *   has used the app for a while (the owner allowed refreshing idle windows).
 * - A window of a pack that does not start (no content 20 s after loading,
 *   a failed load, a crashed renderer) goes back to the bundled interface;
 *   twice and that version is not tried again.
 * - The first launch copies the file:// page's local storage to the new
 *   origin, once.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  app,
  net,
  powerMonitor,
  protocol,
  webContents as allWebContents,
  type WebContents,
} from "electron";
import type { ClaudexUiPack } from "../../shared/claudex-contract";
import {
  bridgeLevel,
  bundledUi,
  safePackPath,
  uiHost,
  uiScheme,
  uiVersionFor,
} from "../../shared/ui-pack";
import { downloadVerified } from "../updates/download";
import { UiPackStore } from "./store";
import { uiPackPublicKey, verifyPack } from "./verify";

/** The scheme's privileges (registered with the others before `ready`). */
export const uiSchemePrivileges = {
  scheme: uiScheme,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
} as const;

/** After this long without content a window's interface counts as broken. */
export const startTimeoutMs = 20_000;
/** Nobody used the app for this long: an idle refresh may load a new interface. */
export const idleRefreshMs = 10 * 60_000;

let store: UiPackStore | undefined;
/** The protocol itself failed this session: windows load the plain files. */
let protocolBroken = false;
const log = (...args: unknown[]) => console.log("[ui-pack]", ...args);

/**
 * Packaged builds with a release key only; `CLAUDEX_DISABLE_UI_PACKS=1` turns
 * packs off.
 */
export function uiPacksAvailable() {
  return (
    app.isPackaged &&
    !!uiPackPublicKey &&
    !process.env.CLAUDEX_DEV_URL &&
    process.env.CLAUDEX_DISABLE_UI_PACKS !== "1"
  );
}

/** Whether windows load through the scheme (else `loadFile` as before). */
export function uiPacksActive() {
  return !!store && !protocolBroken;
}

export function uiPackStore() {
  return store;
}

const page = (body: string) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** Serves `claudex-app://ui/<version>/<path>` from that version's folder. */
async function serve(request: Request): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  if (url.host !== uiHost || !store) return notFound();
  const segments = url.pathname.split("/").filter(Boolean);
  // An empty page of this origin (the local storage copy).
  if (segments.length === 1 && segments[0] === "__blank")
    return page("<!doctype html><title></title>");
  const root = segments[0] && store.rootFor(segments[0]);
  if (!root) return notFound();
  let rel: string;
  try {
    rel = segments.slice(1).map(decodeURIComponent).join("/");
  } catch {
    return notFound();
  }
  if (!safePackPath(rel)) return notFound();
  if (["index.html", "find.html", "quick.html"].includes(rel)) {
    const version = store.pageVersion();
    if (version !== segments[0])
      return Response.redirect(withVersion(request.url, version));
  }
  const file = path.join(root, ...rel.split("/"));
  return net.fetch(pathToFileURL(file).toString());
}

/**
 * Before the first window: opens the store, switches to the target, drops
 * unused packs and starts serving the scheme. Off in development.
 */
export function startUiPacks(options: {
  userData: string;
  appVersion: string;
  bundledDir: string;
}) {
  if (!uiPacksAvailable()) return;
  try {
    store = new UiPackStore(options.userData, {
      bundledVersion: uiVersionFor(options.appVersion),
      bridge: bridgeLevel,
      bundledDir: options.bundledDir,
    });
    const active = store.activate();
    store.prune();
    protocol.handle(uiScheme, serve);
    log("interface", active, "bridge", bridgeLevel);
  } catch (error) {
    log("unavailable:", error);
    store = undefined;
  }
}

/** The address of a page of the interface the windows run now. */
export function uiPageUrl(
  file: "index.html" | "find.html" | "quick.html",
  query?: Record<string, string>,
) {
  const version = store?.pageVersion() ?? bundledUi;
  const url = new URL(`${uiScheme}://${uiHost}/${version}/${file}`);
  for (const [key, value] of Object.entries(query ?? {}))
    url.searchParams.set(key, value);
  return url.toString();
}

/** The same page of another interface version (query kept). */
function withVersion(current: string, version: string) {
  const url = new URL(current);
  const [, ...rest] = url.pathname.split("/").filter(Boolean);
  url.pathname = `/${version}/${rest.join("/") || "index.html"}`;
  return url.toString();
}

function versionOf(contents: WebContents): string | undefined {
  try {
    const url = new URL(contents.getURL());
    if (url.protocol !== `${uiScheme}:` || url.host !== uiHost) return;
    return url.pathname.split("/").filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

/** Loads the plain files when even the bundled interface fails through the scheme. */
let fileFallback: ((contents: WebContents) => void) | undefined;

/**
 * Watches a window that loads the interface: content within 20 s marks the
 * version good; a failure sends the window back to the bundled interface
 * (and, if that fails too, to the plain files).
 */
const watched = new WeakSet<WebContents>();
export function watchUiWindow(
  contents: WebContents,
  plainFiles: (contents: WebContents) => void,
) {
  fileFallback ??= plainFiles;
  if (watched.has(contents)) return;
  watched.add(contents);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checked = new Set<string>();
  const fail = (version: string, why: string) => {
    if (!store || contents.isDestroyed()) return;
    log("interface", version, "did not start:", why);
    if (version === bundledUi) {
      protocolBroken = true;
      plainFiles(contents);
      return;
    }
    const next = store.failed(version);
    void contents.loadURL(withVersion(contents.getURL(), next));
  };
  contents.on("did-finish-load", () => {
    const version = versionOf(contents);
    if (!version || checked.has(`${version}:${contents.getURL()}`)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (contents.isDestroyed() || versionOf(contents) !== version) return;
      contents
        .executeJavaScript(
          "!!document.getElementById('root')?.childElementCount",
          true,
        )
        .then((started) => {
          if (started) {
            checked.add(`${version}:${contents.getURL()}`);
            store?.ready(version);
          } else fail(version, "no content");
        })
        .catch(() => fail(version, "no answer"));
    }, startTimeoutMs);
  });
  contents.on(
    "did-fail-load",
    (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3 /* aborted by a newer load */) return;
      const version = (() => {
        try {
          return new URL(validatedURL).pathname.split("/").filter(Boolean)[0];
        } catch {
          return undefined;
        }
      })();
      if (validatedURL.startsWith(`${uiScheme}:`) && version)
        fail(version, `${code} ${description}`);
    },
  );
  contents.on("render-process-gone", (_event, details) => {
    const version = versionOf(contents);
    // Only a crash soon after loading points at the interface itself.
    if (version && timer && details.reason !== "clean-exit")
      fail(version, details.reason);
  });
  contents.on("destroyed", () => clearTimeout(timer));
}

/**
 * Copies the file:// page's local storage (drafts, view preferences…) to
 * the scheme's origin, once; keys the new origin already has are kept.
 */
export async function migrateLocalStorage(userData: string) {
  if (!store || store.migrated) return;
  const blank = path.join(userData, "ui-packs", ".blank.html");
  let win: BrowserWindow | undefined;
  try {
    fs.mkdirSync(path.dirname(blank), { recursive: true });
    fs.writeFileSync(blank, "<!doctype html><title></title>");
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    await win.loadFile(blank);
    const saved: string = await win.webContents.executeJavaScript(
      "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))",
      true,
    );
    const count = Object.keys(JSON.parse(saved)).length;
    if (count) {
      await win.loadURL(`${uiScheme}://${uiHost}/__blank`);
      await win.webContents.executeJavaScript(
        `(() => { const saved = ${saved}; for (const [k, v] of Object.entries(saved)) if (localStorage.getItem(k) === null && typeof v === "string") localStorage.setItem(k, v); })()`,
        true,
      );
    }
    store.markMigrated();
    log("copied", count, "local storage entries");
  } catch (error) {
    log("local storage copy failed (tried again next launch):", error);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(blank, { force: true });
  }
}

let downloading: Promise<void> | undefined;

/**
 * The service's offer (from the release information): null takes a pack
 * back, undefined (not reachable) changes nothing. A new version is
 * downloaded, verified and installed as the target.
 */
export function offerUiPack(
  ui: ClaudexUiPack | null | undefined,
  onTarget?: () => void,
) {
  if (!store || downloading) return;
  const before = store.target;
  const wanted = store.offer(ui ?? (ui === null ? null : undefined));
  if (!wanted || !ui) {
    if (store.target !== before) onTarget?.();
    return;
  }
  const current = store;
  downloading = (async () => {
    const file = path.join(current.dir, "downloads", `ui-${wanted}.zip`);
    try {
      await downloadVerified({ url: ui.url, file, sha256: ui.sha256 });
      const pack = await verifyPack(fs.readFileSync(file), {
        expectVersion: wanted,
      });
      current.install(pack);
      current.installed(wanted);
      log("interface", wanted, "ready");
      onTarget?.();
    } catch (error) {
      log("interface", wanted, "not installed:", error);
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.part`, { force: true });
      fs.rmSync(`${file}.part.json`, { force: true });
    }
  })().finally(() => {
    downloading = undefined;
  });
}

let lastFocus = Date.now();
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/** Nobody has used the app (or the computer) for `idleRefreshMs`. */
function idle(now = Date.now()) {
  const systemIdle = powerMonitor.getSystemIdleTime() * 1000 >= idleRefreshMs;
  if (BrowserWindow.getFocusedWindow()) {
    lastFocus = now;
    return systemIdle;
  }
  return systemIdle || now - lastFocus >= idleRefreshMs;
}

/**
 * Loads a waiting interface into every window once Claudex is idle: no task
 * running and nobody using the app for ten minutes.
 */
export function startIdleRefresh(isBusy: () => boolean) {
  if (!store || refreshTimer) return;
  app.on("browser-window-blur", () => {
    lastFocus = Date.now();
  });
  let lastReason = "";
  refreshTimer = setInterval(() => {
    if (!store?.pending) return;
    let busy = false;
    try {
      busy = isBusy();
    } catch {
      busy = false; // no account yet: nothing can be running
    }
    const reason = protocolBroken
      ? "the scheme failed this session"
      : busy
        ? "a task is running"
        : !idle()
          ? "the app is in use"
          : !store.runnable(store.target)
            ? `${store.target} is not runnable`
            : "";
    if (reason) {
      if (reason !== lastReason)
        log("refresh to", store.target, "waits:", reason);
      lastReason = reason;
      return;
    }
    lastReason = "";
    const version = store.activate();
    log("idle refresh to", version);
    for (const contents of allWebContents.getAllWebContents()) {
      const current = versionOf(contents);
      if (current && current !== version && !contents.isDestroyed())
        void contents.loadURL(withVersion(contents.getURL(), version));
    }
  }, 60_000);
  refreshTimer.unref?.();
}

/** For the plain-file fallback of a window loaded before the protocol broke. */
export function plainFileFallback() {
  return fileFallback;
}
