import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  type BrowserBounds,
  type BrowserState,
  type BrowserTabState,
  type BrowserColorScheme,
  type BrowserViewport,
  type BrowserSavedPage,
  type DevServerState,
  previewTabOrigin,
  viewportFrame,
} from "../../shared/browser";
import { CdpDriver, type DebuggerLike } from "./cdp";
import { type GuardedContents } from "./navigation-guard";
import { blankTabState } from "./browser-host-support";
import * as browserHostViews from "./browser-host-views";
import { installMethods } from "./install-methods";
import * as browserHostTabs from "./browser-host-tabs";
import * as browserHostDisplay from "./browser-host-display";
import { previewAction, type PreviewInput } from "./preview-input";

/** What BrowserHost uses of a page's `webContents`. */
export interface HostContents extends GuardedContents {
  readonly id?: number;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isDestroyed(): boolean;
  /** Whether the page has the keyboard focus (absent in tests: never). */
  isFocused?(): boolean;
  focus?(): void;
  reload(): void;
  stop(): void;
  close(options?: { waitForBeforeUnload?: boolean }): void;
  capturePage(): Promise<{
    isEmpty(): boolean;
    toJPEG(quality: number): Buffer;
    toPNG(): Buffer;
  }>;
  getUserAgent(): string;
  setAudioMuted?(muted: boolean): void;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getActiveIndex?(): number;
    getEntryAtIndex?(index: number): { url: string } | null;
  };
  debugger: DebuggerLike;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** What BrowserHost uses of a `WebContentsView`. */
export interface HostView {
  readonly webContents: HostContents;
  setBounds(bounds: BrowserBounds): void;
  setBorderRadius?(radius: number): void;
}

/** What BrowserHost uses of an app window. */
export interface HostWindow {
  readonly contentView: {
    addChildView(view: HostView): void;
    removeChildView(view: HostView): void;
  };
  readonly webContents: { getZoomFactor(): number; focus?(): void };
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  on(event: string, listener: () => void): unknown;
}

/** The hidden window pages are parked in (an Electron `BaseWindow`). */
export interface ParkingWindow {
  readonly contentView: HostWindow["contentView"];
  isDestroyed(): boolean;
  setContentSize(width: number, height: number): void;
}

export interface BrowserPlatform {
  /** A sandboxed page view in `partition` (no preload, no Node). */
  createView(partition: string, pdf?: boolean): HostView;
  /**
   * The hidden window pages wait in while not on screen (created when
   * first asked for, again after it was destroyed).
   */
  parking(): ParkingWindow;
  /** The platform name, for key chords ("darwin"). */
  platform?: string;
}

export interface BrowserHostDeps {
  previewEvent?(
    window: HostWindow,
    conversationId: string,
    previewId: string,
    event: string,
    ...args: unknown[]
  ): void;
  routedLink?(url: string): void;
  platform: BrowserPlatform;
  /** The partition a conversation's new pages use (Keep cookies). */
  partition(conversationId: string, url?: string): string;
  savedPage?(conversationId: string): BrowserSavedPage | undefined;
  savePage?(conversationId: string, page: BrowserSavedPage | undefined): void;
  /** The administrator's blocked domains now. */
  blockedDomains(): readonly string[];
  publicHostsOnly?(conversationId: string): boolean;
  /** Whether Claude may drive the panel (Browser tools on and allowed). */
  toolsAvailable(conversationId: string): boolean;
  /** Dev servers of the conversation's folder (R8-B), when there are any. */
  devServers?(conversationId: string): {
    available: boolean;
    servers: DevServerState[];
    launchConfigPath?: string;
    launchConfigError?: string;
    autoVerify?: boolean;
  };
  /** Sends a changed state to the windows. */
  push(state: BrowserState): void;
  /** How long a page may stay loading after it arrived before it is "stalled". */
  stallMs?: number;
}

export interface Tab {
  privateOrigins?: Set<string>;
  privateOrigin?: string;
  writtenFileUrl?: string;
  writtenFileContent?: string;
  writtenFileFolder?: string;
  exportSource?: { path: string; dev: number; ino: number };
  linkRouting?: boolean;
  id: string;
  state: BrowserTabState;
  colorScheme?: BrowserColorScheme;
  emulation?: Promise<void>;
  appliedViewport?: { viewport: BrowserViewport; scale?: number };
  documentEpoch?: number;
  previewCapture?: Buffer;
  view?: HostView;
  driver?: CdpDriver;
  partition?: string;
  userAgent?: string;
  attachedTo?: HostWindow | ParkingWindow;
  stallTimer?: NodeJS.Timeout;
}

export interface Session {
  officialPreview?: {
    id: string;
    window: HostWindow;
    chromeFocused: boolean;
    armed: boolean;
  };
  routePreviewLinks?: boolean;
  closedTabs?: string[];
  conversationId: string;
  tabs: Tab[];
  activeTabId: string;
  viewport: BrowserViewport;
  colorScheme: BrowserColorScheme;
  muted?: boolean;
  version: number;
  picking?: { tab: Tab };
  /** The panel is open in this window at these bounds (CSS pixels of the app page). */
  shown?: {
    window: HostWindow;
    bounds?: BrowserBounds & { radius?: number; parked?: boolean };
    claimant?: string;
  };
  /** The page box last used on screen (window pixels), kept for parked pages. */
  lastBounds?: BrowserBounds;
  occluded: boolean;
  /** Folders of the files opened with Open HTML file…. */
  fileRoots: string[];
  pushTimer?: NodeJS.Timeout;
}

export class BrowserHost {
  configurePreviewInput(
    conversationId: string,
    window: HostWindow,
    id: string,
    patch: { chromeFocused?: boolean; armed?: boolean },
  ) {
    const session = this.session(conversationId);
    if (
      session.officialPreview?.window !== window ||
      session.officialPreview.id !== id
    )
      session.officialPreview = {
        id,
        window,
        chromeFocused: false,
        armed: false,
      };
    Object.assign(session.officialPreview, patch);
  }
  handlePreviewInput(
    event: { preventDefault(): void },
    input: PreviewInput,
    source: HostWindow | HostContents,
  ): boolean {
    for (const session of this.sessions.values()) {
      const config = session.officialPreview;
      if (!config || config.window.isDestroyed()) continue;
      const tab = this.activeTab(session),
        page = tab.view?.webContents === source;
      if (!page && config.window !== source) continue;
      if (session.shown?.window !== config.window || session.occluded) continue;
      if (session.picking && input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        this.cancelPick(session.conversationId);
        return true;
      }
      const action = previewAction(
        input,
        this.deps.platform.platform === "darwin",
        page,
        config.chromeFocused,
        config.armed,
      );
      if (action === undefined) continue;
      event.preventDefault();
      if (input.isAutoRepeat) return true;
      const id = session.conversationId,
        emit = (name: string, tabId?: string) =>
          this.deps.previewEvent?.(config.window, id, config.id, name, ...(tabId === undefined ? [] : [tabId]));
      if (typeof action === "number") {
        const selected =
          action === -1 ? session.tabs.at(-1) : session.tabs[action];
        if (selected) this.selectTab(id, selected.id);
      } else if (action === "next" || action === "previous") {
        const i = session.tabs.indexOf(tab),
          delta = action === "next" ? 1 : -1;
        this.selectTab(
          id,
          session.tabs[(i + delta + session.tabs.length) % session.tabs.length]
            .id,
        );
      } else if (action === "reload") this.reload(id);
      else if (action === "back") this.back(id);
      else if (action === "forward") this.forward(id);
      else {
        const names = {
          close: "previewCloseShortcut",
          new: "previewNewTabShortcut",
          reopen: "previewReopenTabShortcut",
          address: "previewAddressBarShortcut",
          exit: "previewFocusExit",
          pane: "previewPaneShortcut",
          select: "previewSelectionShortcut",
          sketch: "previewSketchShortcut",
        };
        if (action === "exit" || action === "address" || action === "new")
          config.window.webContents.focus?.();
        emit(names[action], action === "close" ? tab.id : undefined);
      }
      return true;
    }
    return false;
  }
  reopenTab(conversationId: string): string | null {
    const session = this.session(conversationId),
      closed = session.closedTabs?.pop();
    if (closed === undefined) return null;
    try {
      return this.newTab(conversationId, closed || undefined);
    } catch (error) {
      session.closedTabs!.push(closed);
      throw error;
    }
  }
  reorderTab(conversationId: string, tabId: string, toIndex: number) {
    const session = this.session(conversationId);
    if (
      !Number.isInteger(toIndex) ||
      toIndex < 0 ||
      toIndex >= session.tabs.length
    )
      throw Error("Invalid tab position.");
    const tab = this.tab(session, tabId);
    session.tabs.splice(session.tabs.indexOf(tab), 1);
    session.tabs.splice(toIndex, 0, tab);
    this.changed(session);
    return true;
  }
  setPreviewLinkRouting(
    conversationId: string,
    tabId: string,
    enabled: boolean,
  ) {
    const tab = this.session(conversationId).tabs.find(
      (candidate) => candidate.id === tabId,
    );
    if (!tab) throw new Error("Unknown browser tab.");
    tab.linkRouting = enabled;
  }
  sessions = new Map<string, Session>();
  private nextTab = 1;
  watchedWindows = new WeakSet<HostWindow>();
  disposed = false;

  constructor(public deps: BrowserHostDeps) {}

  // -------------------------------------------------------------------------
  // State

  session(conversationId: string): Session {
    if (this.disposed) throw new Error("The browser is closed.");
    let session = this.sessions.get(conversationId);
    if (!session) {
      const first = this.blankTab();
      const saved = this.deps.savedPage?.(conversationId);
      if (saved)
        first.state = {
          ...first.state,
          url: saved.url,
          title: saved.title,
          restored: {
            jpegBase64: saved.jpegBase64,
            serverName: saved.serverName,
          },
        };
      session = {
        conversationId,
        tabs: [first],
        activeTabId: first.id,
        viewport: "desktop",
        colorScheme: "system",
        version: 0,
        occluded: false,
        fileRoots: [],
      };
      this.sessions.set(conversationId, session);
    }
    return session;
  }

  blankTab(): Tab {
    const id = `tab-${this.nextTab++}`;
    return { id, state: blankTabState(id) };
  }

  /** Conversations that have a Browser session. */
  conversations() {
    return [...this.sessions.keys()];
  }

  has(conversationId: string) {
    return this.sessions.has(conversationId);
  }

  /**
   * The conversation whose page on screen has the keyboard focus, if any
   * (View ▸ Reload then reloads that page; live claude.ai desktop shell,
   * 2026-10-12: the menu's Reload asks the focused preview tab first).
   */
  focusedConversation(): string | undefined {
    for (const session of this.sessions.values()) {
      if (!session.shown) continue;
      const contents = this.activeTab(session).view?.webContents;
      if (contents && !contents.isDestroyed() && contents.isFocused?.())
        return session.conversationId;
    }
    return undefined;
  }

  /** Give keyboard focus only to the caller's visible active preview. */
  focus(conversationId: string, window: HostWindow): boolean {
    const session = this.sessions.get(conversationId);
    if (!session || session.shown?.window !== window || session.occluded)
      return false;
    const tab = this.activeTab(session);
    const contents = tab.view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      !this.onScreen(tab) ||
      !contents.focus
    )
      return false;
    contents.focus();
    return true;
  }

  state(conversationId: string): BrowserState {
    return this.stateOf(this.session(conversationId));
  }

  agentPageAvailable(conversationId: string, tabId?: string): boolean {
    if (!this.deps.publicHostsOnly?.(conversationId)) return true;
    return !this.tab(this.session(conversationId), tabId).privateOrigins?.size;
  }

  private stateOf(session: Session): BrowserState {
    const dev = this.deps.devServers?.(session.conversationId);
    return {
      conversationId: session.conversationId,
      tabs: session.tabs.map((tab) => ({
        ...tab.state,
        ...(this.deps.publicHostsOnly?.(session.conversationId) && tab.privateOrigins?.size
          ? { toolAccessBlocked: true }
          : {}),
        canExportFile: Boolean(
          tab.exportSource &&
          pathToFileURL(tab.exportSource.path).href === tab.state.url,
        ),
      })),
      activeTabId: session.activeTabId,
      viewport: session.viewport,
      colorScheme: session.colorScheme,
      muted: session.muted,
      devServers: dev?.servers ?? [],
      devServersAvailable: dev?.available ?? false,
      ...(dev?.launchConfigPath
        ? { launchConfigPath: dev.launchConfigPath }
        : {}),
      ...(dev?.launchConfigError
        ? { launchConfigError: dev.launchConfigError }
        : {}),
      ...(dev?.autoVerify !== undefined ? { autoVerify: dev.autoVerify } : {}),
      toolsAvailable: this.deps.toolsAvailable(session.conversationId),
      picking: !!session.picking,
      version: session.version,
    };
  }

  /** Sends the conversation's state again (settings, policy or dev servers changed). */
  refresh(conversationId?: string) {
    for (const session of this.sessions.values())
      if (!conversationId || session.conversationId === conversationId)
        this.changed(session);
  }

  changed(session: Session) {
    session.version++;
    if (session.pushTimer || this.disposed) return;
    session.pushTimer = setTimeout(() => {
      session.pushTimer = undefined;
      if (this.sessions.get(session.conversationId) === session)
        this.deps.push(this.stateOf(session));
    }, 30);
    session.pushTimer.unref?.();
  }

  tab(session: Session, tabId?: string) {
    const id = tabId ?? session.activeTabId;
    const tab = session.tabs.find((value) => value.id === id);
    if (!tab) throw new Error("That tab is closed.");
    return tab;
  }

  activeTab(session: Session) {
    return this.tab(session);
  }

  // -------------------------------------------------------------------------
  // Pages

  guardOptions(session: Session, tab?: Tab) {
    return {
      fileRoots: session.fileRoots,
      blockedDomains: this.deps.blockedDomains(),
      publicHostsOnly: this.deps.publicHostsOnly?.(session.conversationId),
      privateOrigin: tab?.privateOrigin,
      writtenFileUrl: tab?.writtenFileContent?.startsWith("file:") ? tab.writtenFileContent : undefined,
    };
  }

  allowsPrivateRequest(webContentsId: number | undefined, url: string, initiatorOrigin?: string) {
    if (webContentsId === undefined) return false;
    const parsed = URL.parse(url);
    if (!parsed) return false;
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:")
      parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
    const origin = parsed.origin;
    if (initiatorOrigin !== undefined && initiatorOrigin !== origin) return false;
    for (const session of this.sessions.values())
      if (session.tabs.some((tab) =>
        tab.view?.webContents.id === webContentsId && tab.privateOrigin === origin))
        return true;
    return false;
  }

  /** The phone or the panel-wide page; pages reload so they see the new user agent. */
  async setViewport(conversationId: string, viewport: BrowserViewport, tabId?: string) {
    const session = this.session(conversationId);
    if (tabId === undefined && typeof viewport === "object") {
      for (const preset of ["mobile", "tablet"] as const) {
        const frame = viewportFrame(preset)!;
        if (
          viewport.width === frame.width &&
          viewport.height === frame.height
        ) {
          viewport = preset;
          break;
        }
      }
    }
    const tabs = tabId === undefined ? session.tabs : session.tabs.filter((tab) => tab.id === tabId);
    if (!tabs.length) return false;
    if (tabId === undefined) {
      if (session.viewport === viewport) return true;
      session.viewport = viewport;
    } else {
      tabs[0].state.viewport = viewport;
    }
    this.sync(session);
    this.changed(session);
    await Promise.all(tabs.map((tab) =>
      tab.state.viewport === undefined
        ? this.applyEmulation(session, tab, "viewport", true)
        : tab.emulation,
    ));
    return true;
  }

  async setColorScheme(conversationId: string, scheme: BrowserColorScheme, tabId?: string) {
    const session = this.session(conversationId);
    const tabs = tabId === undefined ? session.tabs : session.tabs.filter((tab) => tab.id === tabId);
    if (!tabs.length) return false;
    if (tabId === undefined) {
      if (session.colorScheme === scheme) return true;
      session.colorScheme = scheme;
    } else {
      tabs[0].colorScheme = scheme;
    }
    this.changed(session);
    await Promise.all(tabs.map((tab) => this.applyEmulation(session, tab, "color")));
    return true;
  }

  applyEmulation(
    session: Session,
    tab: Tab,
    mode: "viewport" | "color",
    reload = false,
  ) {
    const { view, driver, userAgent } = tab;
    if (!view || !driver) return;
    const viewport = tab.state.viewport ?? session.viewport;
    const appliedViewport = tab.appliedViewport;
    const scheme = tab.colorScheme ?? session.colorScheme;
    const pending = (tab.emulation ?? Promise.resolve()).then(async () => {
      if (tab.view !== view || view.webContents.isDestroyed()) return;
      if (mode === "viewport") {
        if (tab.state.viewport !== undefined && tab.appliedViewport !== appliedViewport) return;
        await driver.setViewport(viewport, userAgent ?? "", appliedViewport?.scale);
      } else {
        await driver.setColorScheme(scheme);
      }
      if (reload && tab.view === view && tab.state.url && !view.webContents.isDestroyed())
        view.webContents.reload();
    }).catch(() => {});
    tab.emulation = pending;
    return pending;
  }

  setMuted(conversationId: string, muted: boolean) {
    const session = this.session(conversationId);
    session.muted = muted;
    for (const tab of session.tabs)
      tab.view?.webContents.setAudioMuted?.(muted);
    this.changed(session);
    return true;
  }

  /** Answers the active page's confirm, prompt or leave-page dialog. */
  async answerDialog(
    conversationId: string,
    tabId: string,
    accept: boolean,
    text?: string,
  ) {
    const session = this.session(conversationId);
    const tab = this.tab(session, tabId);
    if (!tab.state.dialog || !tab.driver)
      throw new Error("The page isn't asking anything.");
    const prompt = tab.state.dialog.type === "prompt" ? text : undefined;
    await tab.driver.answerDialog(accept, prompt);
    tab.state.dialog = undefined;
    this.changed(session);
  }

  // -------------------------------------------------------------------------
  // Select element

  async pickElement(conversationId: string, tabId?: string) {
    const session = this.session(conversationId);
    const tab = this.tab(session, tabId);
    if (!tab.driver || !tab.state.url || tab.state.error || tab.state.crashed)
      throw new Error("Open a page to select an element.");
    this.cancelPick(conversationId);
    const pick = { tab };
    session.picking = pick;
    this.changed(session);
    try {
      const picked = await tab.driver.pickElement();
      if (!picked || session.picking !== pick) return null;
      return {
        selector: picked.selector,
        tag: picked.tag,
        ...(picked.id ? { id: picked.id } : {}),
        text: picked.text,
        outerHTML: picked.outerHTML,
        styles: picked.styles,
        box: picked.box,
        ...(picked.attributes ? { attributes: picked.attributes } : {}),
        ...(picked.classes ? { classes: picked.classes } : {}),
        ...(picked.screenshotPngBase64
          ? { screenshotPngBase64: picked.screenshotPngBase64 }
          : {}),
        url: tab.state.url,
      };
    } finally {
      if (session.picking === pick) {
        session.picking = undefined;
        this.changed(session);
      }
    }
  }

  cancelPick(conversationId: string) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (session.picking) {
      session.picking.tab.driver?.cancelPick();
      session.picking = undefined;
      this.changed(session);
    }
  }

  // -------------------------------------------------------------------------
  // Screenshots and drivers

  /**
   * A PNG of what the active page shows (Save screenshot, markup): taken
   * from the window when it is on screen, otherwise over CDP.
   */
  async capture(conversationId: string, tabId?: string): Promise<Buffer | undefined> {
    const session = this.session(conversationId);
    const tab = session.tabs.find((entry) => entry.id === (tabId ?? session.activeTabId));
    const view = tab?.view;
    if (!tab || !view || !tab.state.url || tab.state.error || tab.state.crashed)
      return undefined;
    const url = tab.state.url;
    const epoch = tab.documentEpoch;
    const current = () =>
      !this.disposed && this.sessions.get(conversationId) === session &&
      session.tabs.includes(tab) && tab.view === view && tab.state.url === url &&
      tab.documentEpoch === epoch &&
      !view.webContents.isDestroyed();
    const image = await view.webContents
      .capturePage()
      .catch(() => undefined);
    if (!current()) return undefined;
    if (image && !image.isEmpty()) return image.toPNG();
    // Preview overlays use physical pixels and divide by the host's DPR.
    // The model screenshot path resizes images and cannot serve this contract.
    const shot = await (async () => {
      if (!tab.driver) return undefined;
      await tab.driver.waitForDocument();
      return tab.driver.captureScreenshot({
        format: "png",
        fromSurface: false,
        captureBeyondViewport: false,
      });
    })().catch((error) => {
      if (!current()) return undefined;
      throw error;
    });
    if (!shot || !current()) return undefined;
    return Buffer.from(shot.data, "base64");
  }

  async capturePreview(
    conversationId: string,
    options: { tabId?: string; origin?: string; ifChanged?: boolean; force?: boolean },
  ) {
    const session = this.sessions.get(conversationId);
    const tab = session?.tabs.find((entry) => entry.id === (options.tabId ?? session.activeTabId));
    if (!tab || (options.origin !== undefined && previewTabOrigin(tab.state.url) !== options.origin))
      return null;
    const image = await this.capture(conversationId, tab.id);
    if (!image) return null;
    if (options.ifChanged && !options.force && tab.previewCapture?.equals(image)) return "";
    if (options.ifChanged) tab.previewCapture = image;
    return image.toString("base64");
  }

  /**
   * The page Claude drives: the given tab or the active one. The page is
   * created when a blank tab has none yet.
   */
  driver(conversationId: string, tabId?: string) {
    const session = this.session(conversationId);
    const tab = this.tab(session, tabId);
    this.ensureView(session, tab);
    return {
      tabId: tab.id,
      driver: tab.driver!,
      url: tab.state.url,
      state: { ...tab.state },
    };
  }

  /** The address the active tab shows ("" for a blank tab). */
  activeUrl(conversationId: string) {
    const session = this.sessions.get(conversationId);
    if (!session) return "";
    return this.activeTab(session).state.url;
  }

  activePartition(conversationId: string) {
    const session = this.session(conversationId);
    const tab = this.activeTab(session);
    return tab.partition ?? this.deps.partition(conversationId, tab.state.url);
  }

  // -------------------------------------------------------------------------
  // Partitions and cleanup

  /**
   * Pages whose partition is not the one Keep cookies now names are opened
   * again in the new one (same address).
   */
  repartition() {
    for (const session of this.sessions.values()) {
      for (const tab of session.tabs) {
        const partition = this.deps.partition(
          session.conversationId,
          tab.state.url,
        );
        if (!tab.view || tab.partition === partition) continue;
        const url = tab.state.error?.url || tab.state.url;
        this.dropView(tab);
        if (url) this.load(session, tab, url);
      }
      this.sync(session);
      this.changed(session);
    }
  }

  showStartPage(conversationId: string) {
    const session = this.session(conversationId);
    const tab = this.activeTab(session);
    this.dropView(tab);
    tab.state = blankTabState(tab.id);
    this.deps.savePage?.(conversationId, undefined);
    this.changed(session);
  }

  /** Reloads every open page (after Clear browsing data). */
  reloadAll() {
    for (const session of this.sessions.values())
      for (const tab of session.tabs)
        if (tab.view && tab.state.url && !tab.view.webContents.isDestroyed())
          tab.view.webContents.reload();
  }

  /** The tab showing `contents`, for events that name a page (downloads). */
  noteDownloadRefused(contents: unknown, filename: string) {
    for (const session of this.sessions.values())
      for (const tab of session.tabs)
        if (tab.view && tab.view.webContents === contents) {
          tab.state.notice = {
            kind: "download-blocked",
            filename: String(filename).slice(0, 255),
          };
          this.changed(session);
          return;
        }
  }

  /** Closes a conversation's pages (the conversation was deleted). */
  close(conversationId: string) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    this.sessions.delete(conversationId);
    clearTimeout(session.pushTimer);
    for (const tab of session.tabs) {
      this.dropView(tab);
      this.removeWrittenFile(tab);
    }
  }

  removeWrittenFile(tab: Tab) {
    if (tab.writtenFileFolder)
      void fs.promises.rm(tab.writtenFileFolder, { recursive: true, force: true }).catch(() => {});
  }

  /** Closes every page (sign-out, quit). */
  dispose() {
    for (const id of [...this.sessions.keys()]) this.close(id);
    this.disposed = true;
  }
}

export interface BrowserHost {
  show: OmitThisParameter<typeof browserHostDisplay.show>;
  hide: OmitThisParameter<typeof browserHostDisplay.hide>;
  occlude: OmitThisParameter<typeof browserHostDisplay.occlude>;
  viewBounds: OmitThisParameter<typeof browserHostDisplay.viewBounds>;
  windowShowsPages: OmitThisParameter<
    typeof browserHostDisplay.windowShowsPages
  >;
  sync: OmitThisParameter<typeof browserHostDisplay.sync>;
  onScreen: OmitThisParameter<typeof browserHostDisplay.onScreen>;
  watch: OmitThisParameter<typeof browserHostDisplay.watch>;
}
installMethods(BrowserHost.prototype, browserHostDisplay);

export interface BrowserHost {
  newTab: OmitThisParameter<typeof browserHostTabs.newTab>;
  selectTab: OmitThisParameter<typeof browserHostTabs.selectTab>;
  closeTab: OmitThisParameter<typeof browserHostTabs.closeTab>;
  closeOtherTabs: OmitThisParameter<typeof browserHostTabs.closeOtherTabs>;
  dropView: OmitThisParameter<typeof browserHostTabs.dropView>;
}
installMethods(BrowserHost.prototype, browserHostTabs);

export interface BrowserHost {
  ensureView: OmitThisParameter<typeof browserHostViews.ensureView>;
  load: OmitThisParameter<typeof browserHostViews.load>;
  navigate: OmitThisParameter<typeof browserHostViews.navigate>;
  openFile: OmitThisParameter<typeof browserHostViews.openFile>;
  openWrittenFile: OmitThisParameter<typeof browserHostViews.openWrittenFile>;
  exportFile: OmitThisParameter<typeof browserHostViews.exportFile>;
  back: OmitThisParameter<typeof browserHostViews.back>;
  forward: OmitThisParameter<typeof browserHostViews.forward>;
  reload: OmitThisParameter<typeof browserHostViews.reload>;
  stop: OmitThisParameter<typeof browserHostViews.stop>;
}
installMethods(BrowserHost.prototype, browserHostViews);
