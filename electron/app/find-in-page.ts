/**
 * Find in page (shared/find-in-page.ts): one find bar per app window, laid
 * over the window's top-right corner as a view of its own, searching the
 * window's page with Chromium's find. The bar's page asks through its own
 * channels (find-in-page-main.ts); this class only answers the bar it
 * opened, for the window it belongs to.
 *
 * Escape in the page closes an open bar, as does the page navigating; a
 * window that closes takes its bar with it. The class does not import
 * Electron's runtime objects: `FindHost` creates the bar's view, so it runs
 * under the unit tests with fake windows.
 */
import {
  findable,
  findBarBounds,
  findBarPopoutInset,
  findBarTitleInset,
  findChannels,
  findTimeoutMs,
  type FindOptions,
  type FindResult,
} from "../../shared/find-in-page";

type Listener = (...args: any[]) => void;

/** The page a bar searches: an app window's own web contents. */
export interface FindPage {
  isDestroyed(): boolean;
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean },
  ): number;
  stopFindInPage(
    action: "clearSelection" | "keepSelection" | "activateSelection",
  ): void;
  focus(): void;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

/** An app window (main or a conversation's own). */
export interface FindWindow {
  isDestroyed(): boolean;
  getContentBounds(): { width: number; height: number };
  contentView: {
    addChildView(view: never): void;
    removeChildView(view: never): void;
  };
  webContents: FindPage;
  on(event: string, listener: Listener): unknown;
}

/** The bar's own view and page. */
export interface FindBarView {
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
    focus(): void;
    close(): void;
  };
  setBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void;
  setVisible(visible: boolean): void;
}

export interface FindHost {
  /** A transparent view showing find.html with the bar's preload, hidden. */
  createView(): FindBarView;
  /** The main window (its bar sits lower, under the taller title row). */
  isMain?(win: FindWindow): boolean;
  /** The compact density: the main window shows Code. */
  compact?(win: FindWindow): boolean;
}

interface Bar {
  view: FindBarView;
  open: boolean;
  /** A search has started since the bar opened (later ones may step). */
  searched: boolean;
  dispose(): void;
}

/** Escape with no modifiers, as typed (not held). */
function isEscape(input: {
  type?: string;
  key?: string;
  isAutoRepeat?: boolean;
  shift?: boolean;
  control?: boolean;
  alt?: boolean;
  meta?: boolean;
}) {
  return (
    input.type === "keyDown" &&
    input.key === "Escape" &&
    !input.isAutoRepeat &&
    !input.shift &&
    !input.control &&
    !input.alt &&
    !input.meta
  );
}

export class FindInPage {
  private bars = new Map<FindWindow, Bar>();
  constructor(private host: FindHost) {}

  /** Opens the window's bar (or brings it back) and puts the cursor in its field. */
  open(win: FindWindow) {
    if (win.isDestroyed()) return;
    const bar = this.bars.get(win) ?? this.create(win);
    // Added again so it is above anything added since.
    win.contentView.addChildView(bar.view as never);
    this.place(win, bar);
    bar.view.setVisible(true);
    bar.open = true;
    bar.view.webContents.focus();
    bar.view.webContents.send(findChannels.focus);
  }

  /** Closes the window's bar: the highlights go and the page has the keyboard again. */
  close(win: FindWindow) {
    const bar = this.bars.get(win);
    if (!bar?.open) return;
    bar.open = false;
    bar.searched = false;
    bar.view.setVisible(false);
    if (!bar.view.webContents.isDestroyed())
      bar.view.webContents.send(findChannels.clear);
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.stopFindInPage("clearSelection");
      win.webContents.focus();
    }
  }

  isOpen(win: FindWindow) {
    return Boolean(this.bars.get(win)?.open);
  }

  /** Find Next / Find Previous: the open bar steps; a closed one opens. */
  step(win: FindWindow, forward: boolean) {
    const bar = this.bars.get(win);
    if (!bar?.open) return this.open(win);
    bar.view.webContents.send(findChannels.step, forward);
  }

  /** The window whose bar `sender` is, while that bar is open. */
  windowOf(sender: unknown): FindWindow | undefined {
    for (const [win, bar] of this.bars)
      if (bar.open && bar.view.webContents === sender) return win;
    return undefined;
  }

  /** A bar's search: the page's highlighted match and the number of matches. */
  async find(
    sender: unknown,
    query: string,
    options: FindOptions,
  ): Promise<FindResult> {
    const win = this.windowOf(sender);
    const bar = win && this.bars.get(win);
    const none = { active: 0, total: 0 };
    if (!win || !bar || win.webContents.isDestroyed()) return none;
    if (!findable(query)) {
      this.stop(sender);
      return none;
    }
    const page = win.webContents;
    // The first search of a session starts one; Chromium cannot step before.
    const findNext = options.findNext || !bar.searched;
    bar.searched = true;
    return new Promise<FindResult>((resolve) => {
      let id = -1;
      const done = (result: FindResult) => {
        clearTimeout(timer);
        page.removeListener("found-in-page", found);
        resolve(result);
      };
      const found: Listener = (_event, result) => {
        if (result?.requestId !== id || !result.finalUpdate) return;
        done({
          active: result.activeMatchOrdinal ?? 0,
          total: result.matches ?? 0,
        });
      };
      const timer = setTimeout(() => done(none), findTimeoutMs);
      page.on("found-in-page", found);
      id = page.findInPage(query, {
        forward: options.forward ?? true,
        findNext,
      });
    });
  }

  /** The bar's query became too short to search: the highlights go. */
  stop(sender: unknown) {
    const win = this.windowOf(sender);
    const bar = win && this.bars.get(win);
    if (!win || !bar) return;
    bar.searched = false;
    if (!win.webContents.isDestroyed())
      win.webContents.stopFindInPage("clearSelection");
  }

  /** The bar's own close button or Escape. */
  closeFrom(sender: unknown) {
    const win = this.windowOf(sender);
    if (win) this.close(win);
  }

  private place(win: FindWindow, bar: Bar) {
    bar.view.setBounds(
      findBarBounds(
        win.getContentBounds().width,
        this.host.isMain?.(win) === false
          ? findBarPopoutInset
          : findBarTitleInset,
        this.host.compact?.(win) ? "compact" : "comfortable",
      ),
    );
  }

  private create(win: FindWindow): Bar {
    const view = this.host.createView();
    const page = win.webContents;
    const resize = () => {
      const bar = this.bars.get(win);
      if (bar?.open && !win.isDestroyed()) this.place(win, bar);
    };
    const key: Listener = (event, input) => {
      if (!this.isOpen(win) || !isEscape(input ?? {})) return;
      event?.preventDefault?.();
      this.close(win);
    };
    const navigate: Listener = (details) => {
      if (details?.isMainFrame && !details.isSameDocument) this.close(win);
    };
    const bar: Bar = {
      view,
      open: false,
      searched: false,
      dispose: () => {
        page.removeListener("before-input-event", key);
        page.removeListener("did-start-navigation", navigate);
        if (!view.webContents.isDestroyed()) view.webContents.close();
      },
    };
    win.on("resize", resize);
    win.on("closed", () => {
      bar.dispose();
      this.bars.delete(win);
    });
    page.on("before-input-event", key);
    page.on("did-start-navigation", navigate);
    this.bars.set(win, bar);
    return bar;
  }
}
