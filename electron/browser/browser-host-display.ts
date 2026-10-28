import { type BrowserBounds, viewportFrame } from "../../shared/browser";
import { defaultPageSize } from "./browser-host-support";
import type { BrowserHost } from "./browser-host";
import type { HostWindow, ParkingWindow, Tab, Session } from "./browser-host";

// -------------------------------------------------------------------------
// Showing the page

/**
 * The panel is open in `window` with the placeholder at `bounds` (CSS
 * pixels of the app page); the active page is laid over it.
 */
export function show(
  this: BrowserHost,
  conversationId: string,
  window: HostWindow,
  bounds?: BrowserBounds,
) {
  const session = this.session(conversationId);
  // A window shows one conversation's panel: another one's page leaves.
  for (const other of this.sessions.values())
    if (other !== session && other.shown?.window === window) {
      other.shown = undefined;
      other.occluded = false;
      this.sync(other);
    }
  // Opening the panel starts uncovered: a cover left from before (the app
  // page reloaded while a menu was open) would otherwise hide the page.
  if (!bounds) session.occluded = false;
  session.shown = {
    window,
    bounds:
      bounds ??
      (session.shown?.window === window ? session.shown.bounds : undefined),
  };
  this.watch(window);
  this.sync(session);
}

/** The panel closed: its pages stay open (Claude can keep using them) but leave the window. */
export function hide(
  this: BrowserHost,
  conversationId: string,
  window?: HostWindow,
) {
  const session = this.sessions.get(conversationId);
  if (!session || (window && session.shown?.window !== window)) return;
  session.shown = undefined;
  session.occluded = false;
  this.sync(session);
}

/**
 * An app menu or dialog covers the page (`on`) or closed. While covered
 * the page leaves the window; the snapshot (a JPEG data URL) stands in.
 */
export async function occlude(
  this: BrowserHost,
  conversationId: string,
  on: boolean,
) {
  const session = this.session(conversationId);
  let snapshot: string | undefined;
  if (on && !session.occluded) {
    const tab = this.activeTab(session);
    if (tab.view && this.onScreen(tab)) {
      try {
        const image = await tab.view.webContents.capturePage();
        if (!image.isEmpty())
          snapshot = `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
      } catch {
        // The page is covered without a stand-in.
      }
    }
  }
  // A page that had the keyboard focus hands it to the app as it leaves
  // (⇧⌘X pressed in the page opens sketch mode over it).
  const contents = this.activeTab(session).view?.webContents;
  const hadFocus =
    on && contents && !contents.isDestroyed() && contents.isFocused?.();
  session.occluded = on;
  this.sync(session);
  if (hadFocus) session.shown?.window.webContents.focus?.();
  return snapshot ? { snapshot } : {};
}

/**
 * The page's box in the window's own pixels (the app page may be zoomed):
 * the placeholder while the panel is open, else the last one, else the
 * default size. The phone viewport is centred at the phone's width.
 */
export function viewBounds(this: BrowserHost, session: Session): BrowserBounds {
  const shown = session.shown;
  if (shown?.bounds) {
    let zoom = 1;
    try {
      zoom = shown.window.webContents.getZoomFactor() || 1;
    } catch {
      zoom = 1;
    }
    session.lastBounds = {
      x: Math.round(shown.bounds.x * zoom),
      y: Math.round(shown.bounds.y * zoom),
      width: Math.max(1, Math.round(shown.bounds.width * zoom)),
      height: Math.max(1, Math.round(shown.bounds.height * zoom)),
    };
  }
  const base = session.lastBounds ?? {
    x: 0,
    y: 0,
    ...defaultPageSize,
  };
  const frame = viewportFrame(session.viewport);
  if (frame && base.width > frame.width)
    return {
      ...base,
      x: base.x + Math.round((base.width - frame.width) / 2),
      width: frame.width,
    };
  return base;
}

export function windowShowsPages(this: BrowserHost, window: HostWindow) {
  return !window.isDestroyed() && window.isVisible() && !window.isMinimized();
}

/**
 * Attaches the one page that should be on screen to its window; every
 * other page goes to the parking window.
 */
export function sync(this: BrowserHost, session: Session) {
  // A window closing (quitting, say) can be gone before its last event's look
  // comes round: nothing is drawn into it then.
  if (session.shown?.window.isDestroyed()) session.shown = undefined;
  const shown = session.shown;
  const bounds = this.viewBounds(session);
  const active = session.tabs.find((tab) => tab.id === session.activeTabId);
  let parking: ParkingWindow | undefined;
  for (const tab of session.tabs) {
    const view = tab.view;
    if (!view || view.webContents.isDestroyed()) continue;
    const onScreen =
      !!shown?.bounds &&
      !session.occluded &&
      tab === active &&
      !!tab.state.url &&
      !tab.state.error &&
      !tab.state.crashed &&
      this.windowShowsPages(shown.window);
    let target: HostWindow | ParkingWindow;
    if (onScreen) target = shown!.window;
    else {
      parking ??= this.deps.platform.parking();
      if (parking.isDestroyed()) return;
      target = parking;
      parking.setContentSize(
        Math.max(bounds.x + bounds.width, defaultPageSize.width),
        Math.max(bounds.y + bounds.height, defaultPageSize.height),
      );
    }
    if (tab.attachedTo !== target) {
      if (tab.attachedTo && !tab.attachedTo.isDestroyed())
        tab.attachedTo.contentView.removeChildView(view);
      target.contentView.addChildView(view);
      tab.attachedTo = target;
    }
    view.setBounds(bounds);
  }
}

/** Whether a tab's page is on screen in an app window. */
export function onScreen(this: BrowserHost, tab: Tab) {
  const target = tab.attachedTo;
  if (!target) return false;
  for (const session of this.sessions.values())
    if (session.shown?.window === target) return true;
  return false;
}

export function watch(this: BrowserHost, window: HostWindow) {
  if (this.watchedWindows.has(window)) return;
  this.watchedWindows.add(window);
  const resync = () => {
    if (this.disposed || window.isDestroyed()) return;
    for (const session of this.sessions.values())
      if (session.shown?.window === window) this.sync(session);
  };
  // The window's state can change after its event (macOS restores with
  // an animation), so look again a moment later.
  const again = () => {
    resync();
    setTimeout(resync, 250).unref?.();
  };
  for (const event of ["minimize", "restore", "hide", "show"])
    window.on(event, again);
  window.on("closed", () => {
    for (const session of this.sessions.values()) {
      let touched = false;
      for (const tab of session.tabs)
        if (tab.attachedTo === window) {
          tab.attachedTo = undefined;
          touched = true;
        }
      if (session.shown?.window === window) {
        session.shown = undefined;
        session.occluded = false;
        touched = true;
      }
      if (touched && !this.disposed) this.sync(session);
    }
  });
}
