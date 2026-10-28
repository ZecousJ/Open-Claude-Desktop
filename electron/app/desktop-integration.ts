import {
  app,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  Tray,
  type BrowserWindow,
  type WebContents,
} from "electron";
import path from "node:path";
import {
  QuickAccessMonitor,
  quickEntryDictationSupported,
} from "./quick-access";
import { linuxTraySupported } from "./linux-tray";
import type {
  AppCommand,
  Conversation,
  Schedule,
  Settings,
} from "../../shared/types";
import { preference, preferenceDefaults } from "../../shared/settings-extras";
import { ProjectPromptCounts } from "../projects/project-prompt-counts";
import { systemPresence } from "./system-presence";
import { KeepAwakeNoticeTracker } from "./keep-awake-notice";
import {
  levelEffect,
  type NotificationKind,
} from "../../shared/notification-levels";
import {
  CodeWorkTracker,
  TurnWatcher,
  type Notice,
} from "../engine/attention-rules";
import * as desktopNotifications from "./desktop-notifications";
import { installMethods } from "./install-methods";
import * as desktopTrayDock from "./desktop-tray-dock";

interface Options {
  keptAwake?: (conversationId: string, heldMs: number) => void;
  suppressed?: (
    reason: NotificationSuppressionReason,
    conversationId?: string,
  ) => void;
  window: () => BrowserWindow | undefined;
  settings: () => Settings | undefined;
  conversations: () => Conversation[];
  command: (
    command: AppCommand,
    extra?: { conversationId?: string; folder?: string },
  ) => void;
  /** The tray image; absent in builds without it, when the tray is not shown. */
  trayIcon: string;
  /**
   * Brings up (or puts away) the Quick Entry composer (quick-window.ts).
   * Absent: the shortcut shows the main window with a new chat.
   */
  quickEntry?: () => void;
  quickEntryDictation?: (action: "start" | "stop" | "toggle") => void;
  /** The plan and usage the tray menu lists, read when the menu opens. */
  trayStatus?: () => TrayStatus | undefined;
  /**
   * Answers a request from a notification's Allow once button, as the card
   * would. Absent: permission banners have no button.
   */
  respond?: (approvalId: string | number, result: unknown) => unknown;
  /** The repository a Code session's folder belongs to, for its banner's title. */
  repoName?: (cwd: string) => string | undefined;
  /** The clock (tests). */
  now?: () => number;
}

export type NotificationSuppressionReason =
  | "not_initialized"
  | "level_off"
  | "banners_disabled"
  | "viewing_session"
  | "resolved_during_prep"
  | "session_gone"
  | "ci_not_noteworthy"
  | "self_resume_workflow";

/** What the tray menu shows under Show App: the plan and the weekly usage, when known. */
export interface TrayStatus {
  plan?: string;
  /** Whole percent of the weekly limit used. */
  usagePercent?: number;
  /** The usage couldn't be read: a greyed "Usage unavailable" line. */
  usageUnavailable?: boolean;
}

/**
 * The app's windows as notifications and the menu bar icon reach them (R2):
 * a conversation may have its own window besides the main one.
 */
export interface IntegrationWindows {
  /** Brings the conversation's own window forward; false when it has none. */
  focusConversation(conversationId: string): boolean;
  /**
   * Brings the main window forward, opening the conversation there when one
   * is named; false when there is no main window.
   */
  showMain(conversationId?: string): boolean;
  /**
   * Whether the person is looking at the conversation: an app window that
   * shows it is in front. Absent: any app window in front counts.
   */
  viewing?(conversationId: string): boolean;
}

/**
 * System integration behind Settings: notifications, attention requests,
 * keeping the computer awake, the menu bar icon and the Quick access
 * shortcut. Everything reads the signed-in account's settings when used.
 */
/**
 * The Quick Entry shortcut to register: the saved one, and Alt+Space until
 * one is saved (desktop client 2.37337.1: the default global shortcut). macOS
 * starts Quick Entry by the Option double tap instead.
 */
export function quickAccessShortcut(saved: string | undefined) {
  return (
    saved ??
    (process.platform === "darwin"
      ? ""
      : preferenceDefaults.quickAccessShortcut)
  );
}

export class DesktopIntegration {
  turns = new TurnWatcher();
  work = new CodeWorkTracker();
  schedules: Schedule[] = [];
  scheduledAttention = new Map<string, Notice>();
  scheduledAttentionTimer?: NodeJS.Timeout;
  blocker?: number;
  awakeNotices = new KeepAwakeNoticeTracker();
  codeHold = false;
  keepAwakeTimer?: ReturnType<typeof setTimeout>;
  /** Banners on screen by tag, so they can be withdrawn (and are not collected). */
  shown = new Map<
    string,
    { notification: Notification; conversationId?: string }
  >();
  /**
   * Requests waiting for the person: approval id → its banner's tag and,
   * for a Code or Cowork permission or question, its kind (Chat's
   * approvals are the window's own in the original: no badge, no bounce).
   */
  waiting = new Map<
    string | number,
    { tag?: string; kind?: NotificationKind; conversationId?: string }
  >();
  /**
   * The conversations seen last, by id: a cloud conversation (Sync with
   * the web) is not in the local store when its request arrives.
   */
  seen = new Map<string, Conversation>();
  cloudSeen = new Set<string>();
  /** The number on the Dock icon now ("" for none). */
  private badge = "";
  private projectPrompts = new ProjectPromptCounts(() => this.updateBadge());
  rendererNotifications = new Set<Notification>();
  /** The Dock bounce asking for attention (macOS), until nothing waits. */
  private bounce?: number;
  private flashing = false;
  tray?: Tray;
  shortcuts = new Set<string>();
  private accessMonitor = new QuickAccessMonitor(
    () => {
      const settings = this.options.settings();
      if (
        settings &&
        preference(settings, "quickEntryShortcut") === "double-tap-option"
      )
        this.openQuickEntry();
    },
    (action) => {
      const settings = this.options.settings();
      if (
        settings &&
        quickEntryDictationSupported() &&
        preference(settings, "quickEntryDictationShortcut") === "capslock"
      )
        this.options.quickEntryDictation?.(action);
    },
  );
  ready = false;
  private presenceCleanup?: () => void;
  approvalTimers = new Map<string | number, ReturnType<typeof setTimeout>>();
  private windows?: IntegrationWindows;
  constructor(public options: Options) {}
  /**
   * Lets a notification open its conversation where it is shown: its own
   * window when it has one, otherwise the main window (R2).
   */
  connectWindows(windows: IntegrationWindows) {
    this.windows = windows;
  }
  /** Whether the menu bar (tray) icon is up, a way back to a hidden window. */
  hasTray() {
    return !!this.tray;
  }
  /**
   * "unsupported" on a Linux desktop that shows no tray icons: no icon is
   * made there, so closing the window quits instead of hiding it.
   */
  trayIconStatus(): "supported" | "unsupported" {
    return this.trayUnsupported ? "unsupported" : "supported";
  }
  trayUnsupported = false;
  openQuickEntry() {
    if (this.options.quickEntry) return this.options.quickEntry();
    this.showMain();
    this.options.command("new-chat");
  }
  /** Called once the app is ready; power events are not available before. */
  start() {
    if (this.ready) return;
    this.ready = true;
    this.presenceCleanup = systemPresence.subscribe(() => {
      this.updateKeepAwake();
      this.observeViewing();
    });
    this.refreshDockMenu();
    powerMonitor.on("on-battery", () => this.updateKeepAwake());
    powerMonitor.on("on-ac", () => this.updateKeepAwake());
    // The tray icon and the shortcut stand before anyone is signed in.
    const apply = () => {
      try {
        this.apply();
      } catch (error) {
        console.error("Quick access shortcut:", (error as Error).message);
      }
    };
    apply();
    if (process.platform === "linux")
      void linuxTraySupported().then((supported) => {
        this.trayUnsupported = !supported;
        apply();
      });
  }
  get focused() {
    const window = this.options.window();
    return !!window && !window.isDestroyed() && window.isFocused();
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  /**
   * Whether the person is looking at the conversation: the original keeps a
   * session's banners away only while the app is in front showing that
   * session; a banner about another session still shows.
   */
  viewing(conversationId: string | undefined) {
    if (this.ready && systemPresence.isLocked()) return false;
    if (!this.focused) return false;
    if (!conversationId || !this.windows?.viewing) return true;
    return this.windows.viewing(conversationId);
  }
  setProjectPromptsWaiting(sender: WebContents, count: number) {
    this.projectPrompts.set(sender, count);
  }
  /** Takes a banner away: its request was answered, or its session opened. */
  withdraw(tag: string) {
    const entry = this.shown.get(tag);
    if (!entry) return;
    this.shown.delete(tag);
    entry.notification.close();
  }
  /** A notification's click: its conversation, or the main window. */
  open(conversationId?: string) {
    if (conversationId && this.windows?.focusConversation(conversationId))
      return;
    if (!this.windows?.showMain(conversationId)) this.show();
  }
  /** The main window, which runs New Chat and Open Claudex. */
  showMain() {
    if (!this.windows?.showMain()) this.show();
  }
  private show() {
    const window = this.options.window();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  /**
   * Asks for attention from the Dock (macOS) or taskbar (Windows, Linux)
   * while a request waits: the original bounces the Dock until the request
   * is answered ("critical"), and stops when nothing waits any more. Only
   * with "Draw attention on notifications" on (off by default there too).
   */
  attention() {
    const settings = this.options.settings();
    if (!settings || !preference(settings, "drawAttention") || this.focused)
      return;
    if (process.platform === "darwin") {
      if (this.bounce !== undefined) app.dock?.cancelBounce(this.bounce);
      const id = app.dock?.bounce("critical");
      this.bounce = id !== undefined && id >= 0 ? id : undefined;
    } else {
      const window = this.options.window();
      if (window && !window.isDestroyed()) {
        window.flashFrame(true);
        this.flashing = true;
      }
    }
  }
  stopAttention() {
    if (this.bounce !== undefined) app.dock?.cancelBounce(this.bounce);
    this.bounce = undefined;
    if (this.flashing) {
      const window = this.options.window();
      if (window && !window.isDestroyed()) window.flashFrame(false);
      this.flashing = false;
    }
  }
  /** What a kind of notice does under the current settings. */
  effect(kind: NotificationKind) {
    const settings = this.options.settings();
    return settings
      ? levelEffect(settings, kind)
      : { banner: false, badge: false };
  }
  /**
   * The Dock icon's number (macOS): the requests waiting for the person
   * whose level counts in the badge, as the original's `updateBadge`.
   */
  updateBadge() {
    let count = this.effect("permission").badge ? this.projectPrompts.count : 0;
    for (const { kind } of this.waiting.values())
      if (kind && this.effect(kind).badge) count++;
    const label = count > 0 ? String(count) : "";
    if (label === this.badge) return;
    this.badge = label;
    if (process.platform === "darwin") app.dock?.setBadge(label);
  }
  dockMenuKey = "";
  translation?: { locale: string; translate: (text: string) => string };
  /** Applies the current account's settings; with none, everything is switched off. */
  apply() {
    if (!this.ready) return;
    const settings = this.options.settings();
    this.updateKeepAwake();
    // The tray icon and the Quick Entry shortcut belong to the app, not to an
    // account: they stand from the start and while signed out, on the local
    // defaults (the desktop client creates the tray when the app is ready,
    // menuBarEnabled true; the shortcut brings the window forward until
    // someone is signed in).
    this.updateTray(
      settings ? preference(settings, "menuBar") : preferenceDefaults.menuBar,
    );
    const access = settings
      ? preference(settings, "quickEntryShortcut")
      : "off";
    const accelerator =
      access === "off" || access === "double-tap-option" ? "" : access;
    const voice =
      settings && quickEntryDictationSupported()
        ? preference(settings, "quickEntryDictationShortcut")
        : "off";
    this.updateShortcuts(
      [quickAccessShortcut(settings?.quickAccessShortcut), accelerator],
      voice === "off" || voice === "capslock" ? "" : voice,
    );
    this.accessMonitor.setEnabled(
      access === "double-tap-option" || voice === "capslock",
    );
  }
  stop() {
    this.presenceCleanup?.();
    this.presenceCleanup = undefined;
    this.ready = false;
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    clearTimeout(this.keepAwakeTimer);
    this.keepAwakeTimer = undefined;
    if (this.blocker !== undefined) powerSaveBlocker.stop(this.blocker);
    this.blocker = undefined;
    this.accessMonitor.setEnabled(false);
    this.updateShortcuts([]);
  }
  reset() {
    this.seen.clear();
    this.cloudSeen.clear();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    clearTimeout(this.scheduledAttentionTimer);
    this.scheduledAttentionTimer = undefined;
    this.scheduledAttention.clear();
    this.turns.reset();
    this.work.reset();
    this.awakeNotices.release(false);
    this.codeHold = false;
    this.schedules = [];
    this.waiting.clear();
    this.projectPrompts.clear();
    this.stopAttention();
    this.refreshDockMenu();
    for (const tag of [...this.shown.keys()]) this.withdraw(tag);
    for (const notification of this.rendererNotifications) notification.close();
    this.rendererNotifications.clear();
    this.updateKeepAwake();
  }
  static trayIconPath(resources: string | undefined, dirname: string) {
    // macOS menu bar icons are template images: the knot in black with its
    // alpha, which the system recolours.
    if (process.platform === "darwin")
      return resources
        ? path.join(resources, "tray-iconTemplate.png")
        : path.join(dirname, "../build/tray-iconTemplate.png");
    return resources
      ? path.join(resources, "tray-icon.png")
      : path.join(dirname, "../build/icon.iconset/icon_32x32.png");
  }
}

export interface DesktopIntegration {
  refreshKeepAwake(
    ...args: Parameters<typeof desktopTrayDock.refreshKeepAwake>
  ): ReturnType<typeof desktopTrayDock.refreshKeepAwake>;
  translate(
    ...args: Parameters<typeof desktopTrayDock.translate>
  ): ReturnType<typeof desktopTrayDock.translate>;
  refreshDockMenu(
    ...args: Parameters<typeof desktopTrayDock.refreshDockMenu>
  ): ReturnType<typeof desktopTrayDock.refreshDockMenu>;
  updateKeepAwake(
    ...args: Parameters<typeof desktopTrayDock.updateKeepAwake>
  ): ReturnType<typeof desktopTrayDock.updateKeepAwake>;
  updateTray(
    ...args: Parameters<typeof desktopTrayDock.updateTray>
  ): ReturnType<typeof desktopTrayDock.updateTray>;
  trayMenu(
    ...args: Parameters<typeof desktopTrayDock.trayMenu>
  ): ReturnType<typeof desktopTrayDock.trayMenu>;
  updateShortcuts(
    ...args: Parameters<typeof desktopTrayDock.updateShortcuts>
  ): ReturnType<typeof desktopTrayDock.updateShortcuts>;
}
installMethods(DesktopIntegration.prototype, desktopTrayDock);

export interface DesktopIntegration {
  notify(
    ...args: Parameters<typeof desktopNotifications.notify>
  ): ReturnType<typeof desktopNotifications.notify>;
  supportsNotificationActions(
    ...args: Parameters<typeof desktopNotifications.supportsNotificationActions>
  ): ReturnType<typeof desktopNotifications.supportsNotificationActions>;
  showNotification(
    ...args: Parameters<typeof desktopNotifications.showNotification>
  ): ReturnType<typeof desktopNotifications.showNotification>;
  observeConversation(
    ...args: Parameters<typeof desktopNotifications.observeConversation>
  ): ReturnType<typeof desktopNotifications.observeConversation>;
  observeCodeNotifications(
    ...args: Parameters<typeof desktopNotifications.observeCodeNotifications>
  ): ReturnType<typeof desktopNotifications.observeCodeNotifications>;
  observeApproval(
    ...args: Parameters<typeof desktopNotifications.observeApproval>
  ): ReturnType<typeof desktopNotifications.observeApproval>;
  observeApprovalResolved(
    ...args: Parameters<typeof desktopNotifications.observeApprovalResolved>
  ): ReturnType<typeof desktopNotifications.observeApprovalResolved>;
  observeViewing(
    ...args: Parameters<typeof desktopNotifications.observeViewing>
  ): ReturnType<typeof desktopNotifications.observeViewing>;
  observeSchedules(
    ...args: Parameters<typeof desktopNotifications.observeSchedules>
  ): ReturnType<typeof desktopNotifications.observeSchedules>;
  queueScheduledAttention(
    ...args: Parameters<typeof desktopNotifications.queueScheduledAttention>
  ): ReturnType<typeof desktopNotifications.queueScheduledAttention>;
}
installMethods(DesktopIntegration.prototype, desktopNotifications);
