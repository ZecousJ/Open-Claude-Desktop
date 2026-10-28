import { z } from "zod";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Rectangle,
  WebContents,
} from "electron";
import type { AppEvent, Attachment } from "../../shared/types";
import type { WindowHandoff } from "../../shared/windows-api";
import type { ToolPaneKind } from "../../shared/tool-pane";
import type { AppWindows } from "./app-context";
import { SessionPopouts } from "./session-popouts";
import type { OpenLayout } from "../../shared/window-layout";
import { stateSchema } from "./chat-windows-support";
import * as chatWindowsLayout from "./chat-windows-layout";
import { installMethods } from "./install-methods";
import * as chatWindowsOpen from "./chat-windows-open";

/** A handoff the main process checked: its attachments are resolved. */
export type CheckedHandoff = WindowHandoff & { attachments: Attachment[] };

/** What a conversation window needs to know about a conversation. */
export interface ChatWindowConversation {
  title: string;
  incognito?: boolean;
  mode?: string;
  environment?: { kind: string };
}

export interface ChatWindowsHost {
  /** Creates the window (`new BrowserWindow(options)` in the app). */
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  windows: Pick<
    AppWindows,
    "main" | "focused" | "register" | "load" | "send" | "webPreferences"
  >;
  /** Sends an event to every app window. */
  push(event: AppEvent): void;
  /** The work areas of the connected displays, the primary one first. */
  workAreas(): Rectangle[];
  /** Where the geometry is remembered; undefined while no profile is open. */
  statePath(): string | undefined;
  layoutPath?(): string | undefined;
  platform: NodeJS.Platform;
  /** Whether the windows paint dark (for the background before the page loads). */
  dark(): boolean;
  /** The signed-in account's conversation, or undefined when there is none. */
  conversation(id: string): ChatWindowConversation | undefined;
  project?(id: string): { name: string } | undefined;
  /** How often open windows check their conversation still exists (ms). */
  sweepMs?: number;
}
export type ChatWindowState = z.infer<typeof stateSchema>;

export interface OpenWindow {
  conversationId: string;
  pane?: ToolPaneKind;
  win: BrowserWindow;
  /** The draft handed over, until the window takes it. */
  handoff?: CheckedHandoff;
  handoffTaken: boolean;
  visible: boolean;
}

export class ChatWindows {
  projects = new Map<BrowserWindow, string>();
  sessions: SessionPopouts;
  open = new Map<BrowserWindow, OpenWindow>();
  /** Opening order, for cascading the next window off the newest one. */
  order: BrowserWindow[] = [];
  /** A draft a separate window handed back to the main window. */
  private mainHandoff?: CheckedHandoff;
  private lastVisible = "[]";
  saveTimer?: ReturnType<typeof setTimeout>;
  sweepTimer?: ReturnType<typeof setInterval>;
  preservingLayout = false;
  restoringLayout = false;
  constructor(public host: ChatWindowsHost) {
    this.sessions = new SessionPopouts(() => host.layoutPath?.());
  }

  reportOpenLayout(layout: OpenLayout) {
    if (!this.preservingLayout) this.sessions.report(layout);
  }

  preserveLayout() {
    this.saveLayout();
    this.preservingLayout = true;
  }

  /** The window showing a conversation, if one is open. */
  forConversation(conversationId: string, pane?: ToolPaneKind) {
    for (const [win, entry] of this.open)
      if (
        entry.conversationId === conversationId &&
        entry.pane === pane &&
        !win.isDestroyed()
      )
        return win;
    return undefined;
  }

  /** The conversation a separate window shows; undefined for any other window. */
  conversationOf(win: BrowserWindow | undefined) {
    return win ? this.open.get(win)?.conversationId : undefined;
  }

  /** The window whose page is `contents`, when it is a separate window. */
  windowOf(contents: WebContents | undefined) {
    for (const win of [...this.open.keys(), ...this.projects.keys()])
      if (!win.isDestroyed() && win.webContents === contents) return win;
    return undefined;
  }

  /** Conversations open in separate windows, oldest window first. */
  conversationIds() {
    return [
      ...new Set(
        this.order
          .filter((win) => !win.isDestroyed())
          .flatMap((win) => this.open.get(win)?.conversationId ?? []),
      ),
    ];
  }

  /** Focuses the conversation's window; false when it has none. */
  focusConversation(conversationId: string) {
    const win = this.forConversation(conversationId);
    if (!win) return false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }

  /**
   * A separate window's Return: closes it and has the main window open the
   * conversation, with the window's draft kept for the main window.
   */
  returnToMain(win: BrowserWindow, handoff?: CheckedHandoff) {
    const conversationId = this.conversationOf(win);
    if (!conversationId) return false;
    this.mainHandoff = handoff;
    win.close();
    this.showMain({
      type: "command",
      command: "open-conversation",
      conversationId,
    });
    return true;
  }

  /** Keeps a separate window above other windows; returns the new state. */
  setPinned(win: BrowserWindow, on: boolean) {
    if ((!this.open.has(win) && !this.projects.has(win)) || win.isDestroyed())
      return false;
    win.setAlwaysOnTop(on, "floating");
    this.saveLayout();
    return win.isAlwaysOnTop();
  }

  /**
   * The draft handed to a window, once: a separate window reads what the
   * main window handed it, the main window what a separate one handed back.
   */
  takeHandoff(win: BrowserWindow | undefined) {
    if (!win) return null;
    const entry = this.open.get(win);
    if (entry) {
      const handoff = entry.handoffTaken ? undefined : entry.handoff;
      entry.handoffTaken = true;
      entry.handoff = undefined;
      return handoff ?? null;
    }
    if (win !== this.host.windows.main()) return null;
    const handoff = this.mainHandoff;
    this.mainHandoff = undefined;
    return handoff ?? null;
  }

  /**
   * Drops every draft not taken yet (sign-out, account switch): a draft and
   * its attachments belong to the account that wrote them.
   */
  dropHandoffs() {
    this.mainHandoff = undefined;
    for (const entry of this.open.values()) {
      entry.handoff = undefined;
      entry.handoffTaken = true;
    }
  }

  /** A separate window reports whether the person can see it. */
  reportVisibility(win: BrowserWindow, visible: boolean) {
    const entry = this.open.get(win);
    if (!entry) return;
    entry.visible = visible;
    this.pushVisibility();
  }

  /** Brings the main window forward and sends it a command. */
  showMain(event: Extract<AppEvent, { type: "command" }>) {
    const main = this.host.windows.main();
    if (!main) return false;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    this.host.windows.send(main, event);
    return true;
  }

  /** Closes the conversation's window (the conversation is gone). */
  closeFor(conversationId: string) {
    for (const [win, entry] of this.open)
      if (entry.conversationId === conversationId && !win.isDestroyed())
        win.close();
  }

  /** Closes every separate window. */
  closeAll() {
    for (const win of [...this.projects.keys()])
      if (!win.isDestroyed()) win.close();
    for (const win of [...this.open.keys()])
      if (!win.isDestroyed()) win.close();
  }

  /** Closes the windows whose conversation was deleted or can no longer show. */
  sweep() {
    for (const [win, id] of this.projects)
      if (!this.host.project?.(id) && !win.isDestroyed()) win.close();
    for (const [win, entry] of this.open) {
      const conversation = this.host.conversation(entry.conversationId);
      if (!conversation || conversation.incognito)
        if (!win.isDestroyed()) win.close();
    }
  }

  available(conversationId: string) {
    const conversation = this.host.conversation(conversationId);
    if (!conversation || conversation.incognito)
      throw new Error("This conversation isn't available.");
    return conversation;
  }

  forget(win: BrowserWindow) {
    const entry = this.open.get(win);
    const closed = entry?.pane ? undefined : entry?.conversationId;
    if (!this.open.delete(win)) return;
    this.order = this.order.filter((value) => value !== win);
    this.saveLayout();
    if (!this.open.size && !this.projects.size) {
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.pushVisibility();
    // The main window keeps it for File ▸ Reopen Closed Session.
    if (closed)
      this.host.push({
        type: "conversation-window-closed",
        conversationId: closed,
      });
  }

  startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => this.sweep(),
      this.host.sweepMs ?? 1500,
    );
    // The check alone never keeps the app running.
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  /** Tells every window which conversations a visible separate window shows. */
  private pushVisibility() {
    const conversationIds = [
      ...new Set(
        [...this.open.values()]
          .filter((entry) => entry.visible && !entry.win.isDestroyed())
          .map((entry) => entry.conversationId),
      ),
    ].sort();
    const key = JSON.stringify(conversationIds);
    if (key === this.lastVisible) return;
    this.lastVisible = key;
    this.host.push({ type: "window-visibility", conversationIds });
  }
}

export interface ChatWindows {
  openProject: OmitThisParameter<typeof chatWindowsOpen.openProject>;
  openConversation: OmitThisParameter<typeof chatWindowsOpen.openConversation>;
}
installMethods(ChatWindows.prototype, chatWindowsOpen);

export interface ChatWindows {
  takeRestorableLayout: OmitThisParameter<
    typeof chatWindowsLayout.takeRestorableLayout
  >;
  restoreLayout: OmitThisParameter<typeof chatWindowsLayout.restoreLayout>;
  saveLayout: OmitThisParameter<typeof chatWindowsLayout.saveLayout>;
  layoutState: OmitThisParameter<typeof chatWindowsLayout.layoutState>;
  windowOptions: OmitThisParameter<typeof chatWindowsLayout.windowOptions>;
  placement: OmitThisParameter<typeof chatWindowsLayout.placement>;
  scheduleSave: OmitThisParameter<typeof chatWindowsLayout.scheduleSave>;
  saveNow: OmitThisParameter<typeof chatWindowsLayout.saveNow>;
}
installMethods(ChatWindows.prototype, chatWindowsLayout);
