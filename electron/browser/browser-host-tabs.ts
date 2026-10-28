import type { BrowserHost } from "./browser-host";
import type { Tab } from "./browser-host";

/** A new tab (blank, or opening `url`); returns its id. */
export function newTab(
  this: BrowserHost,
  conversationId: string,
  url?: string,
  foreground = true,
) {
  const session = this.session(conversationId);
  const tab = this.blankTab();
  const previous = session.activeTabId;
  session.tabs.push(tab);
  if (foreground) session.activeTabId = tab.id;
  if (url) {
    const result = this.navigate(conversationId, url, tab.id);
    if (!result.ok) {
      this.closeTab(conversationId, tab.id);
      if (session.tabs.some((value) => value.id === previous))
        session.activeTabId = previous;
      this.sync(session);
      throw new Error(result.message);
    }
  }
  this.sync(session);
  this.changed(session);
  return tab.id;
}

export function selectTab(
  this: BrowserHost,
  conversationId: string,
  tabId: string,
) {
  const session = this.session(conversationId);
  this.tab(session, tabId);
  if (session.picking) this.cancelPick(conversationId);
  session.activeTabId = tabId;
  this.sync(session);
  this.changed(session);
}

/** Closes a tab; the panel always keeps one (a new blank tab replaces the last). */
export function closeTab(
  this: BrowserHost,
  conversationId: string,
  tabId: string,
) {
  const session = this.session(conversationId);
  const index = session.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  const [tab] = session.tabs.splice(index, 1);
  if (session.activeTabId === tabId && session.picking) session.picking = false;
  if (session.activeTabId === tabId)
    this.deps.savePage?.(conversationId, undefined);
  this.dropView(tab);
  if (!session.tabs.length) session.tabs.push(this.blankTab());
  if (!session.tabs.some((value) => value.id === session.activeTabId))
    session.activeTabId =
      session.tabs[Math.min(index, session.tabs.length - 1)].id;
  this.sync(session);
  this.changed(session);
}

export function closeOtherTabs(
  this: BrowserHost,
  conversationId: string,
  tabId: string,
) {
  const session = this.session(conversationId);
  this.tab(session, tabId);
  for (const tab of [...session.tabs])
    if (tab.id !== tabId) this.closeTab(conversationId, tab.id);
  this.selectTab(conversationId, tabId);
}

export function dropView(this: BrowserHost, tab: Tab) {
  clearTimeout(tab.stallTimer);
  tab.driver?.dispose();
  tab.driver = undefined;
  const view = tab.view;
  tab.view = undefined;
  if (!view) return;
  if (tab.attachedTo && !tab.attachedTo.isDestroyed())
    tab.attachedTo.contentView.removeChildView(view);
  tab.attachedTo = undefined;
  try {
    if (!view.webContents.isDestroyed())
      view.webContents.close({ waitForBeforeUnload: false });
  } catch {
    // Already gone.
  }
}
