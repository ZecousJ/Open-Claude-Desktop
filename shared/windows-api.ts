/**
 * Separate conversation windows (R2, Pop out chat). A conversation opens in
 * its own window (`index.html?window=conversation&id=<id>`), which shows only
 * that conversation; events reach every app window.
 *
 * The interface and method list were frozen by S0; the handlers are in
 * `electron/ipc/windows.ts` and the windows in `electron/chat-windows.ts`
 * (R2-B). The calls a separate window makes about itself (return, pin,
 * visibility, forward) act on the calling window only and do nothing from
 * the main window. A handoff's attachments must be ones the person added in
 * this session; `takeWindowHandoff` returns them resolved.
 */
import { bridgeMethods } from "./bridge-methods";
import type { AppCommand, Attachment } from "./types";
import type { MenuState } from "./menu-state";
import type { ToolPaneKind } from "./tool-pane";

/** The composer draft handed to the window that shows the conversation next. */
export interface WindowHandoff {
  text: string;
  attachmentIds: string[];
  /** The attachments behind `attachmentIds`, as the main process knows them (`takeWindowHandoff`). */
  attachments?: Attachment[];
  providerId?: string;
  model?: string;
  webSearch?: boolean;
}

/** A command a separate window hands to the main window. */
export type ForwardedCommand = AppCommand | { openConversation: string };

export interface WindowsAPI {
  getWindowPinned(): Promise<boolean>;
  windowLayoutState(): Promise<{
    popoutSessionIds: string[];
    visibleSessionIds: string[];
    otherPopoutCount: number;
  }>;
  openProjectWindow(projectId: string): Promise<void>;
  reportOpenLayout(layout: import("./window-layout").OpenLayout): Promise<void>;
  reportOpenPopouts(
    popouts: import("./window-layout").SessionPopout[],
  ): Promise<void>;
  takeRestorableLayout(): Promise<import("./window-layout").OpenLayout | null>;
  takeRestorablePopouts(): Promise<
    import("./window-layout").SessionPopout[] | null
  >;
  setLayoutCommandListening(listening: boolean): Promise<void>;
  reportLayoutCommandResult(
    result: import("./window-layout").LayoutCommandResult,
  ): Promise<void>;
  openToolPaneWindow(conversationId: string, pane: ToolPaneKind): Promise<void>;
  /** Opens (or focuses) the conversation's own window; `handoff` is this window's draft. */
  openConversationWindow(
    conversationId: string,
    handoff?: WindowHandoff,
    options?: { showInactive?: boolean },
  ): Promise<void>;
  /** A separate window: closes itself and has the main window open the conversation. */
  returnToMainWindow(handoff?: WindowHandoff): Promise<void>;
  /** A separate window: keeps it above other windows; returns the new state. */
  setWindowPinned(on: boolean): Promise<boolean>;
  /** A separate window's first load: the draft handed to it, once. */
  takeWindowHandoff(): Promise<WindowHandoff | null>;
  /** A separate window reports whether the person can see it. */
  reportWindowVisibility(visible: boolean): Promise<void>;
  /** A separate window hands a command that does not apply to it to the main window. */
  forwardToMainWindow(command: ForwardedCommand): Promise<void>;
  /** Conversations open in separate windows now. */
  conversationWindows(): Promise<string[]>;
  /**
   * The main window reports what the application menu shows (item names,
   * Show or Hide, what is enabled). Other windows' reports are ignored.
   */
  reportMenuState(state: MenuState): Promise<void>;
}

export const windowsMethods = bridgeMethods<WindowsAPI>({
  getWindowPinned: true,
  windowLayoutState: true,
  openProjectWindow: true,
  reportOpenLayout: true,
  reportOpenPopouts: true,
  takeRestorableLayout: true,
  takeRestorablePopouts: true,
  setLayoutCommandListening: true,
  reportLayoutCommandResult: true,
  openToolPaneWindow: true,
  openConversationWindow: true,
  returnToMainWindow: true,
  setWindowPinned: true,
  takeWindowHandoff: true,
  reportWindowVisibility: true,
  forwardToMainWindow: true,
  conversationWindows: true,
  reportMenuState: true,
});

/**
 * The conversations shown in a separate window the person can see now: a reply
 * that finishes there is not marked unread by the main window.
 */
export interface WindowVisibilityEvent {
  type: "window-visibility";
  conversationIds: string[];
}

/**
 * A separate conversation window closed (or the conversation went away):
 * the main window keeps it for File ▸ Reopen Closed Session.
 */
export interface ConversationWindowClosedEvent {
  type: "conversation-window-closed";
  conversationId: string;
}
