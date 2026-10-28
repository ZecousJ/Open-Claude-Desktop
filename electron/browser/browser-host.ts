import { pathToFileURL } from "node:url";
import {
  type BrowserBounds,
  type BrowserState,
  type BrowserTabState,
  type BrowserColorScheme,
  type BrowserViewport,
  type BrowserSavedPage,
  type DevServerState,
  viewportFrame,
} from "../../shared/browser";
import { CdpDriver, type DebuggerLike } from "./cdp";
import { type GuardedContents } from "./navigation-guard";
import { blankTabState } from "./browser-host-support";
import * as browserHostViews from "./browser-host-views";
import { installMethods } from "./install-methods";
import * as browserHostTabs from "./browser-host-tabs";
import * as browserHostDisplay from "./browser-host-display";

/** What BrowserHost uses of a page's `webContents`. */
export interface HostContents extends GuardedContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isDestroyed(): boolean;
  /** Whether the page has the keyboard focus (absent in tests: never). */
  isFocused?(): boolean;
  reload(): void;
  stop(): void;
  close(options?: { waitForBeforeUnload?: boolean }): void;
  capturePage(): Promise<{
    isEmpty(): boolean;
    toJPEG(quality: number): Buffer;
    toPNG(): Buffer;
  }>;
  getUserAgent(): string;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
  };
  debugger: DebuggerLike;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** What BrowserHost uses of a `WebContentsView`. */
export interface HostView {
  readonly webContents: HostContents;
  setBounds(bounds: BrowserBounds): void;
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
  createView(partition: string): HostView;
  /**
   * The hidden window pages wait in while not on screen (created when
   * first asked for, again after it was destroyed).
   */
  parking(): ParkingWindow;
  /** The platform name, for key chords ("darwin"). */
  platform?: string;
}

export interface BrowserHostDeps {
  routedLink?(url: string): void;
  platform: BrowserPlatform;
  /** The partition a conversation's new pages use (Keep cookies). */
  partition(conversationId: string, url?: string): string;
  savedPage?(conversationId: string): BrowserSavedPage | undefined;
  savePage?(conversationId: string, page: BrowserSavedPage | undefined): void;
  /** The administrator's blocked domains now. */
  blockedDomains(): readonly string[];
  /** Whether Claude may drive the panel (Browser tools on and allowed). */
  toolsAvailable(): boolean;
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
  exportSource?: { path: string; dev: number; ino: number };
  linkRouting?: boolean;
  id: string;
  state: BrowserTabState;
  view?: HostView;
  driver?: CdpDriver;
  partition?: string;
  userAgent?: string;
  attachedTo?: HostWindow | ParkingWindow;
  stallTimer?: NodeJS.Timeout;
}

export interface Session {
  conversationId: string;
  tabs: Tab[];
  activeTabId: string;
  viewport: BrowserViewport;
  colorScheme: BrowserColorScheme;
  version: number;
  picking: boolean;
  /** The panel is open in this window at these bounds (CSS pixels of the app page). */
  shown?: { window: HostWindow; bounds?: BrowserBounds };
  /** The page box last used on screen (window pixels), kept for parked pages. */
  lastBounds?: BrowserBounds;
  occluded: boolean;
  /** Folders of the files opened with Open HTML file…. */
  fileRoots: string[];
  pushTimer?: NodeJS.Timeout;
}

export class BrowserHost {
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
        picking: false,
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

  /** The conversation whose page on screen has the keyboard focus, if any. */
  focusedConversation(): string | undefined {
    for (const session of this.sessions.values()) {
      if (!session.shown) continue;
      const contents = this.activeTab(session).view?.webContents;
      if (contents && !contents.isDestroyed() && contents.isFocused?.())
        return session.conversationId;
    }
    return undefined;
  }

  state(conversationId: string): BrowserState {
    return this.stateOf(this.session(conversationId));
  }

  private stateOf(session: Session): BrowserState {
    const dev = this.deps.devServers?.(session.conversationId);
    return {
      conversationId: session.conversationId,
      tabs: session.tabs.map((tab) => ({
        ...tab.state,
        canExportFile: Boolean(
          tab.exportSource &&
          pathToFileURL(tab.exportSource.path).href === tab.state.url,
        ),
      })),
      activeTabId: session.activeTabId,
      viewport: session.viewport,
      colorScheme: session.colorScheme,
      devServers: dev?.servers ?? [],
      devServersAvailable: dev?.available ?? false,
      ...(dev?.launchConfigPath
        ? { launchConfigPath: dev.launchConfigPath }
        : {}),
      ...(dev?.launchConfigError
        ? { launchConfigError: dev.launchConfigError }
        : {}),
      ...(dev?.autoVerify !== undefined ? { autoVerify: dev.autoVerify } : {}),
      toolsAvailable: this.deps.toolsAvailable(),
      picking: session.picking,
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

  guardOptions(session: Session) {
    return {
      fileRoots: session.fileRoots,
      blockedDomains: this.deps.blockedDomains(),
    };
  }

  /** The phone or the panel-wide page; pages reload so they see the new user agent. */
  async setViewport(conversationId: string, viewport: BrowserViewport) {
    const session = this.session(conversationId);
    if (typeof viewport === "object") {
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
    if (session.viewport === viewport) return;
    session.viewport = viewport;
    this.sync(session);
    this.changed(session);
    await Promise.all(
      session.tabs.map(async (tab) => {
        if (!tab.driver || !tab.view) return;
        await tab.driver
          .setViewport(viewport, tab.userAgent ?? "")
          .catch(() => {});
        if (tab.state.url && !tab.view.webContents.isDestroyed())
          tab.view.webContents.reload();
      }),
    );
  }

  /** The prefers-color-scheme every page of the conversation sees. */
  async setColorScheme(conversationId: string, scheme: BrowserColorScheme) {
    const session = this.session(conversationId);
    if (session.colorScheme === scheme) return;
    session.colorScheme = scheme;
    this.changed(session);
    await Promise.all(
      session.tabs.map((tab) =>
        tab.driver?.setColorScheme(scheme).catch(() => {}),
      ),
    );
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

  async pickElement(conversationId: string) {
    const session = this.session(conversationId);
    const tab = this.activeTab(session);
    if (!tab.driver || !tab.state.url || tab.state.error || tab.state.crashed)
      throw new Error("Open a page to select an element.");
    session.picking = true;
    this.changed(session);
    try {
      const picked = await tab.driver.pickElement();
      if (!picked) return null;
      return {
        selector: picked.selector,
        tag: picked.tag,
        text: picked.text,
        outerHTML: picked.outerHTML,
        styles: picked.styles,
        box: picked.box,
        ...(picked.screenshotPngBase64
          ? { screenshotPngBase64: picked.screenshotPngBase64 }
          : {}),
        url: tab.state.url,
      };
    } finally {
      session.picking = false;
      this.changed(session);
    }
  }

  cancelPick(conversationId: string) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    for (const tab of session.tabs) tab.driver?.cancelPick();
    if (session.picking) {
      session.picking = false;
      this.changed(session);
    }
  }

  // -------------------------------------------------------------------------
  // Screenshots and drivers

  /**
   * A PNG of what the active page shows (Save screenshot, markup): taken
   * from the window when it is on screen, otherwise over CDP.
   */
  async capture(conversationId: string): Promise<Buffer | undefined> {
    const session = this.session(conversationId);
    const tab = this.activeTab(session);
    if (!tab.view || !tab.state.url || tab.state.error || tab.state.crashed)
      return undefined;
    const image = await tab.view.webContents
      .capturePage()
      .catch(() => undefined);
    if (image && !image.isEmpty()) return image.toPNG();
    const shot = await tab.driver?.screenshot();
    if (!shot) return undefined;
    return Buffer.from(shot.base64, "base64");
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
    for (const tab of session.tabs) this.dropView(tab);
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
  exportFile: OmitThisParameter<typeof browserHostViews.exportFile>;
  back: OmitThisParameter<typeof browserHostViews.back>;
  forward: OmitThisParameter<typeof browserHostViews.forward>;
  reload: OmitThisParameter<typeof browserHostViews.reload>;
  stop: OmitThisParameter<typeof browserHostViews.stop>;
}
installMethods(BrowserHost.prototype, browserHostViews);
