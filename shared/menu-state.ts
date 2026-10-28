/**
 * What the main window tells the application menu so its items follow the
 * window: the first item's name (New Chat, New Task, New Session), Show or Hide
 * for the sidebar and the Code panes, Back and Forward, Previous and Next, and
 * whether there is a pane to close or a session to reopen. The original's menu
 * does the same through its window-control reports.
 */
import type { Mode } from "./types";

/**
 * What the Split View menu may do (the original's report, source: desktop
 * bundle 2.31226.1): room for a new session on the right or below, panes to
 * focus and close, and the directions the focused pane can move in.
 */
export interface SplitMenuState {
  newRight: boolean;
  newBelow: boolean;
  /** Something is split: Focus and Close work. */
  split: boolean;
  moveLeft: boolean;
  moveRight: boolean;
  moveUp: boolean;
  moveDown: boolean;
}

export const noSplitMenu: SplitMenuState = {
  newRight: false,
  newBelow: false,
  split: false,
  moveLeft: false,
  moveRight: false,
  moveUp: false,
  moveDown: false,
};

/** A pane the View menu toggles: whether it can open here, and whether it is open. */
export interface MenuPaneState {
  enabled: boolean;
  open: boolean;
}

export interface MenuState {
  closeTarget?: "Chat" | "Task" | "Page" | "Session" | "Pane";
  findInFiles?: boolean;
  mode: Mode;
  sidebarOpen: boolean;
  /** The window shows a page that has a sidebar to toggle. */
  sidebarEnabled: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Go ▸ Previous and Next: the sidebar lists a conversation to go to. */
  canCycleSession: boolean;
  panes: {
    terminal: MenuPaneState;
    changes: MenuPaneState;
    browser: MenuPaneState;
    /** View ▸ Files (the Files pane, a local Code session's folder). */
    files?: MenuPaneState;
  };
  /** View ▸ Side Chat: whether the open conversation can have one, and whether it is shown. */
  sideChat: MenuPaneState;
  /** Something is open that Close Pane would close. */
  canClosePane: boolean;
  /** View ▸ Split View: what its items can do now. */
  splitView: SplitMenuState;
  /** A closed conversation or window can be reopened. */
  canReopenClosed: boolean;
  /**
   * Go's area list: the sidebar's surfaces as checkboxes when there are two or
   * more.
   */
  areas?: MenuArea[];
  /**
   * The conversations the window shows now (the open one and the split
   * view's sessions). Not part of the menu: notifications are not shown for
   * a session the person is looking at, and its banners are withdrawn when
   * they open it (electron/desktop-integration.ts).
   */
  viewing?: string[];
}

export interface MenuArea {
  id: "chat" | "code";
  label: string;
  selected: boolean;
}

const closedPane: MenuPaneState = { enabled: false, open: false };

/** The menu before the window has reported: Chat, nothing to toggle. */
export const initialMenuState: MenuState = {
  mode: "chat",
  sidebarOpen: true,
  sidebarEnabled: true,
  canGoBack: false,
  canGoForward: false,
  canCycleSession: false,
  panes: {
    terminal: closedPane,
    changes: closedPane,
    browser: closedPane,
  },
  sideChat: closedPane,
  canClosePane: false,
  splitView: noSplitMenu,
  canReopenClosed: false,
};

/** Whether two reports show the same menu (`viewing` is not part of it). */
export const sameMenuState = (a: MenuState, b: MenuState) => {
  const { viewing: _a, ...menuA } = a;
  const { viewing: _b, ...menuB } = b;
  return JSON.stringify(menuA) === JSON.stringify(menuB);
};
