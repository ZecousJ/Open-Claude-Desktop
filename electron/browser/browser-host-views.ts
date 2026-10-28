import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  type BrowserNavigateResult,
  newTabTitle,
  normalizeAddress,
  pageOrigin,
} from "../../shared/browser";
import { CdpDriver } from "./cdp";
import { guardContents, navigationAllowed } from "./navigation-guard";
import { faviconLimit } from "./browser-host-support";
import { hostOf } from "./browser-host-support";
import type { BrowserHost } from "./browser-host";
import type { HostView, Tab, Session } from "./browser-host";

/** Creates the tab's page when it has none yet. */
export function ensureView(
  this: BrowserHost,
  session: Session,
  tab: Tab,
): HostView {
  if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
  const partition = this.deps.partition(session.conversationId, tab.state.url);
  const view = this.deps.platform.createView(partition);
  tab.view = view;
  tab.partition = partition;
  const contents = view.webContents;
  tab.userAgent = contents.getUserAgent();
  guardContents(contents, () => this.guardOptions(session), {
    routeLink: (url) => {
      if (!this.deps.routedLink) return false;
      const source = contents.getURL();
      const preview =
        tab.linkRouting ??
        /^(?:file:|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$))/i.test(
          source,
        );
      if (!preview || !/^https?:/i.test(url)) return false;
      try {
        if (new URL(source).origin === new URL(url).origin) return false;
      } catch {
        return false;
      }
      this.deps.routedLink(url);
      return true;
    },
    refused: (url, reason) => {
      if (reason !== "blocked") return;
      tab.state.error = {
        code: 0,
        description: "BLOCKED_BY_ADMINISTRATOR",
        url,
      };
      tab.state.loading = false;
      this.sync(session);
      this.changed(session);
    },
    openTab: (url, foreground) => {
      if (this.sessions.get(session.conversationId) !== session) return;
      try {
        this.newTab(session.conversationId, url, foreground);
      } catch {
        // A window the rules refuse simply does not open.
      }
    },
  });
  const update = () => {
    if (contents.isDestroyed()) return;
    tab.state.canGoBack = contents.navigationHistory.canGoBack();
    tab.state.canGoForward = contents.navigationHistory.canGoForward();
    this.changed(session);
  };
  contents.on("did-start-loading", () => {
    tab.state.loading = true;
    tab.state.notice = undefined;
    update();
  });
  contents.on("did-stop-loading", () => {
    tab.state.loading = false;
    tab.state.stalled = false;
    clearTimeout(tab.stallTimer);
    update();
    const savedUrl = tab.state.url;
    if (this.deps.savePage && /^https?:/.test(savedUrl) && !tab.state.error)
      void contents
        .capturePage()
        .then((image) => {
          if (
            image.isEmpty() ||
            contents.isDestroyed() ||
            this.disposed ||
            this.sessions.get(session.conversationId) !== session ||
            tab.state.url !== savedUrl ||
            !session.tabs.includes(tab) ||
            tab !== this.activeTab(session)
          )
            return;
          const server = this.deps
            .devServers?.(session.conversationId)
            .servers.find(
              (server) =>
                server.url &&
                pageOrigin(server.url) === pageOrigin(tab.state.url),
            );
          this.deps.savePage?.(session.conversationId, {
            url: tab.state.url,
            title: tab.state.title,
            jpegBase64: image.toJPEG(70).toString("base64"),
            serverName: server?.name,
          });
        })
        .catch(() => {});
  });
  contents.on("did-navigate", (_event: unknown, url: string) => {
    tab.state.url = url;
    if (tab.partition !== this.deps.partition(session.conversationId, url)) {
      this.dropView(tab);
      this.load(session, tab, url);
      return;
    }
    // Chromium commits its own error page at the failed address; the
    // panel keeps showing the error until another page arrives.
    if (tab.state.error?.url !== url) tab.state.error = undefined;
    tab.state.crashed = false;
    tab.state.dialog = undefined;
    tab.state.title = contents.getTitle() || hostOf(url) || newTabTitle;
    tab.state.faviconUrl = undefined;
    // The document arrived; finishing takes at most stallMs more.
    clearTimeout(tab.stallTimer);
    tab.state.stalled = false;
    if (contents.isLoading()) {
      tab.stallTimer = setTimeout(() => {
        if (!contents.isDestroyed() && contents.isLoading()) {
          tab.state.stalled = true;
          this.changed(session);
        }
      }, this.deps.stallMs ?? 20_000);
      tab.stallTimer.unref?.();
    }
    this.sync(session);
    update();
  });
  contents.on(
    "did-navigate-in-page",
    (_event: unknown, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      tab.state.url = url;
      update();
    },
  );
  contents.on("page-title-updated", (_event: unknown, title: string) => {
    tab.state.title =
      String(title).slice(0, 500) || hostOf(tab.state.url) || newTabTitle;
    this.changed(session);
  });
  contents.on("page-favicon-updated", (_event: unknown, favicons: string[]) => {
    const icon = (favicons ?? []).find(
      (value) =>
        /^(?:https?:|data:image\/)/i.test(value) &&
        value.length <= faviconLimit,
    );
    tab.state.faviconUrl = icon;
    this.changed(session);
  });
  contents.on(
    "did-fail-load",
    (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, or stopped.
      if (!isMainFrame || errorCode === -3) return;
      tab.state.error = {
        code: errorCode,
        description: String(errorDescription || `Error ${errorCode}`),
        url: validatedURL,
      };
      tab.state.url = validatedURL || tab.state.url;
      tab.state.loading = false;
      tab.state.stalled = false;
      clearTimeout(tab.stallTimer);
      this.sync(session);
      update();
    },
  );
  contents.on("render-process-gone", () => {
    tab.state.crashed = true;
    tab.state.loading = false;
    tab.state.stalled = false;
    tab.state.dialog = undefined;
    clearTimeout(tab.stallTimer);
    this.sync(session);
    this.changed(session);
  });
  const driver = new CdpDriver(contents.debugger, {
    platform: this.deps.platform.platform,
    dialogOpened: (dialog) => {
      tab.state.dialog = {
        type: dialog.type,
        message: dialog.message,
        origin: pageOrigin(dialog.url || tab.state.url),
        ...(dialog.defaultPrompt !== undefined
          ? { defaultValue: dialog.defaultPrompt }
          : {}),
      };
      this.changed(session);
    },
    dialogClosed: () => {
      tab.state.dialog = undefined;
      this.changed(session);
    },
  });
  tab.driver = driver;
  void driver
    .attach()
    .then(async () => {
      if (session.viewport !== "desktop")
        await driver.setViewport(session.viewport, tab.userAgent ?? "");
      if (session.colorScheme !== "system")
        await driver.setColorScheme(session.colorScheme);
    })
    .catch(() => {
      // The page answers through Electron alone until the next attach.
    });
  this.sync(session);
  return view;
}

export function load(
  this: BrowserHost,
  session: Session,
  tab: Tab,
  url: string,
) {
  const partition = this.deps.partition(session.conversationId, url);
  if (tab.view && tab.partition !== partition) this.dropView(tab);
  tab.state.url = url;
  tab.state.restored = undefined;
  const view = this.ensureView(session, tab);
  tab.state.url = url;
  tab.state.error = undefined;
  tab.state.crashed = false;
  tab.state.notice = undefined;
  if (tab.state.title === newTabTitle || !tab.state.title)
    tab.state.title = hostOf(url) || newTabTitle;
  // Load failures arrive as did-fail-load.
  view.webContents.loadURL(url).catch(() => {});
  this.sync(session);
  this.changed(session);
}

/**
 * Opens what the person typed (or Claude asked for) in a tab, the active
 * one by default. Words that are not an address, other schemes and
 * blocked sites are refused with a message for the address bar.
 */
export function navigate(
  this: BrowserHost,
  conversationId: string,
  input: string,
  tabId?: string,
): BrowserNavigateResult {
  const session = this.session(conversationId);
  const tab = this.tab(session, tabId);
  const address = normalizeAddress(input, { fileRoots: session.fileRoots });
  if (!address.ok) return address;
  const decision = navigationAllowed(address.url, this.guardOptions(session));
  if (!decision.allow)
    return {
      ok: false,
      message:
        decision.reason === "blocked"
          ? "Your administrator doesn't allow this site."
          : "The built-in browser can't open that address.",
    };
  this.load(session, tab, address.url);
  return address;
}

/** Opens a file the person chose with Open HTML file…; its folder may then load. */
export function openFile(
  this: BrowserHost,
  conversationId: string,
  file: string,
  tabId?: string,
) {
  const session = this.session(conversationId);
  const tab = this.tab(session, tabId);
  try {
    const source = fs.statSync(file);
    tab.exportSource = { path: file, dev: source.dev, ino: source.ino };
  } catch {
    tab.exportSource = undefined;
  }
  const folder = path.dirname(path.resolve(file));
  if (!session.fileRoots.includes(folder)) session.fileRoots.push(folder);
  return this.navigate(conversationId, pathToFileURL(file).href, tabId);
}

// Bind exports to the file the user opened, not a path supplied by the page.
export async function exportFile(this: BrowserHost, conversationId: string) {
  const tab = this.activeTab(this.session(conversationId));
  const source = tab.exportSource;
  if (!source || pathToFileURL(source.path).href !== tab.state.url)
    throw new Error("Page couldn’t be saved. Try again.");
  const file = await fs.promises.open(
    source.path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.dev !== source.dev ||
      info.ino !== source.ino ||
      info.size > 64 * 1024 * 1024
    )
      throw new Error("Page couldn’t be saved. Try again.");
    return { bytes: await file.readFile(), name: path.basename(source.path) };
  } finally {
    await file.close();
  }
}

export function back(this: BrowserHost, conversationId: string) {
  const session = this.session(conversationId);
  const contents = this.activeTab(session).view?.webContents;
  if (contents?.navigationHistory.canGoBack())
    contents.navigationHistory.goBack();
}

export function forward(this: BrowserHost, conversationId: string) {
  const session = this.session(conversationId);
  const contents = this.activeTab(session).view?.webContents;
  if (contents?.navigationHistory.canGoForward())
    contents.navigationHistory.goForward();
}

/** Reload; after a load error or crash, opens the address again. */
export function reload(this: BrowserHost, conversationId: string) {
  const session = this.session(conversationId);
  const tab = this.activeTab(session);
  if (!tab.state.url) return;
  if (
    tab.state.error ||
    tab.state.crashed ||
    !tab.view ||
    tab.view.webContents.isDestroyed()
  ) {
    const url = tab.state.error?.url || tab.state.url;
    if (tab.state.crashed) this.dropView(tab);
    this.load(session, tab, url);
    return;
  }
  tab.view.webContents.reload();
}

export function stop(this: BrowserHost, conversationId: string) {
  const session = this.session(conversationId);
  this.activeTab(session).view?.webContents.stop();
}
