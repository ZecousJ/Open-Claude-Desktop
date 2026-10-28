import type { AppCommand, Mode } from "../../shared/types";
import {
  noSplitMenu,
  type MenuPaneState,
  type MenuState,
  type SplitMenuState,
} from "../../shared/menu-state";
import type { DockPanel } from "./useToolPanels";
import type { SidePanel } from "../conversation/ToolSidePanel";

/**
 * What the application menu and the Code pane shortcuts need from the
 * window, kept apart from React so it runs under the unit tests
 * (ShellMenuHost.tsx is the component that wires it).
 */

/** Conversations the person left or closed, most recent last (File ▸ Reopen Closed Session). */
export class ClosedSessions {
  private ids: string[] = [];
  /** Remembers one; asking again moves it to the end. */
  push(id: string, limit = 20) {
    this.ids = [...this.ids.filter((value) => value !== id), id].slice(-limit);
  }
  /** The ids that can still be reopened, most recent first. */
  reopenable(valid: (id: string) => boolean) {
    return this.ids.filter(valid).reverse();
  }
  /** Takes the most recent id that is still valid, forgetting it and the invalid ones above it. */
  take(valid: (id: string) => boolean) {
    while (this.ids.length) {
      const id = this.ids.pop()!;
      if (valid(id)) return id;
    }
    return undefined;
  }
}

/** One pane's state: it opens only in an open Code conversation where the host has it. */
export function paneState(
  available: boolean,
  open: boolean,
  inCode: boolean,
): MenuPaneState {
  return { enabled: available && inCode, open: open && inCode };
}

/** File's contextual close. */
export function closeMenuTarget(
  mode: Mode,
  chatPage: boolean,
  hasConversation: boolean,
  canClosePane: boolean,
): MenuState["closeTarget"] {
  if (!chatPage) return "Page";
  if (mode === "code")
    return hasConversation ? "Session" : canClosePane ? "Pane" : undefined;
  return hasConversation ? "Chat" : undefined;
}

export function menuStateFor(input: {
  mode: Mode;
  sidebarOpen: boolean;
  sidebarEnabled: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The sidebar lists a conversation Previous and Next can go to. */
  canCycleSession?: boolean;
  inCodeConversation: boolean;
  isOpen: (panel: SidePanel) => boolean;
  terminalAvailable: boolean;
  browserAvailable: boolean;
  artifactOpen: boolean;
  anyPanelOpen: boolean;
  canReopenClosed: boolean;
  /** The Files pane can open here (a local Code session on the desktop). */
  filesAvailable?: boolean;
  /** The open conversation can have a side chat (Chat and Code, after its first reply). */
  sideChatAvailable?: boolean;
  sideChatOpen?: boolean;
  /** What View ▸ Split View can do (src/split-view); greyed when absent. */
  splitView?: SplitMenuState;
  /** The conversations on screen (see `MenuState.viewing`). */
  viewing?: string[];
  closeTarget?: MenuState["closeTarget"];
  /** Go's area list (see `MenuState.areas`). */
  areas?: MenuState["areas"];
}): MenuState {
  const inCode = input.inCodeConversation;
  return {
    ...(input.viewing ? { viewing: input.viewing } : {}),
    mode: input.mode,
    closeTarget: input.closeTarget,
    findInFiles: inCode && Boolean(input.filesAvailable),
    sidebarOpen: input.sidebarOpen,
    sidebarEnabled: input.sidebarEnabled,
    canGoBack: input.canGoBack,
    canGoForward: input.canGoForward,
    canCycleSession: Boolean(input.canCycleSession),
    panes: {
      terminal: paneState(
        input.terminalAvailable,
        input.isOpen("terminal"),
        inCode,
      ),
      changes: paneState(true, input.isOpen("changes"), inCode),
      browser: paneState(
        input.browserAvailable,
        input.isOpen("browser"),
        inCode,
      ),
      ...(input.filesAvailable !== undefined
        ? {
            files: paneState(
              input.filesAvailable,
              input.isOpen("files"),
              inCode,
            ),
          }
        : {}),
    },
    sideChat: {
      enabled: Boolean(input.sideChatAvailable),
      open: Boolean(input.sideChatAvailable && input.sideChatOpen),
    },
    canClosePane: input.artifactOpen || input.anyPanelOpen,
    splitView: input.splitView ?? noSplitMenu,
    canReopenClosed: input.canReopenClosed,
    ...(input.areas && input.areas.length >= 2 ? { areas: input.areas } : {}),
  };
}

/**
 * What View ▸ Close Pane closes: the file viewer when it is open (it sits
 * beside the tool panels, last), else a panel shown alone, else the last
 * card of the dock.
 */
export function paneToClose(open: {
  artifact: boolean;
  single: SidePanel | null;
  dock: readonly DockPanel[];
}): "artifact" | SidePanel | undefined {
  if (open.artifact) return "artifact";
  if (open.single) return open.single;
  return open.dock[open.dock.length - 1];
}

let commandHandler: ((command: AppCommand) => boolean) | undefined;

/**
 * Lets the mounted ShellMenuHost run the commands that need the window's
 * state (panes, Open File, Reopen Closed Session); returns how to let go.
 */
export function setShellCommandHandler(
  handler: (command: AppCommand) => boolean,
) {
  commandHandler = handler;
  return () => {
    if (commandHandler === handler) commandHandler = undefined;
  };
}

/** Runs a command through the host; false when it is none of the host's. */
export const runShellCommand = (command: AppCommand) =>
  commandHandler?.(command) ?? false;

/**
 * Ctrl+Alt+P or Cmd+Option+P: pin or unpin the open chat. Matched by the
 * physical key, because Option+P types another character on macOS.
 */
export function isPinChord(event: {
  code: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}) {
  return (
    event.code === "KeyP" &&
    event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey)
  );
}

/** The window event the Browser panel listens to for its keyboard commands. */
export const browserCommandEvent = "claudex:browser-command";

export type BrowserKeyCommand =
  | "new-tab"
  | "focus-address"
  | "next-tab"
  | "previous-tab"
  | "reopen-tab"
  /** ⇧⌘S: Select element starts, or stops while it waits for a click. */
  | "select-element"
  /** ⇧⌘X: sketch mode on the page starts, or asks to end. */
  | "sketch"
  | { tab: number };

export interface BrowserCommandDetail {
  command: BrowserKeyCommand;
  /** Set by the panel when it acted on the command. */
  handled: boolean;
}

/** Sends a keyboard command to the open Browser panel; true when it acted. */
export function sendBrowserCommand(command: BrowserKeyCommand) {
  const detail: BrowserCommandDetail = { command, handled: false };
  window.dispatchEvent(new CustomEvent(browserCommandEvent, { detail }));
  return detail.handled;
}

/** The tab a Browser key command lands on; undefined when there is none. */
export function browserTabFor(
  command: BrowserKeyCommand,
  tabIds: readonly string[],
  activeId: string | undefined,
) {
  if (!tabIds.length) return undefined;
  const index = activeId ? tabIds.indexOf(activeId) : -1;
  if (command === "next-tab") return tabIds[(index + 1) % tabIds.length];
  if (command === "previous-tab")
    return tabIds[(Math.max(index, 0) - 1 + tabIds.length) % tabIds.length];
  // ⌘9 is the last tab, however many there are.
  if (typeof command === "object")
    return command.tab === 9 ? tabIds.at(-1) : tabIds[command.tab - 1];
  return undefined;
}

/** The Browser tab number a command stands for ("browser-tab-3" is 3). */
export function browserTabNumber(command: string) {
  const match = /^browser-tab-([1-9])$/.exec(command);
  return match ? Number(match[1]) : undefined;
}
