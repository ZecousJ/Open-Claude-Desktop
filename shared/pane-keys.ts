/**
 * The Code pane shortcuts, one table for both sides: the window's key table
 * (src/host/keys.ts) and the built-in browser's pages, whose keys never reach
 * the window while a page has the focus (electron/browser/index.ts forwards
 * them).
 *
 * The keys are the original's: Terminal is ⌘J on macOS and Ctrl+` everywhere;
 * Changes ⇧⌘D; Browser ⇧⌘B; Side Chat ⌘;; Close Pane ⌘\; in the Browser, ⌘T a
 * new tab, ⌘L the address bar, Ctrl+Tab and Ctrl+Shift+Tab the next and
 * previous tab, ⌘1 to ⌘9 a tab by number. ⇧⌘T reopens what was closed last (the
 * Browser's closed tab, else File ▸ Reopen Closed Session). ⇧⌘\ expands or
 * restores the focused pane and ⇧⌘S starts Select element in the Browser. ⇧⌘X
 * sketches on the Browser's page (toggleSketchMode).
 *
 * Ctrl+Tab, Ctrl+Shift+Tab and ⌘1 to ⌘9 are the window's Next chat, Previous
 * chat and Jump to chat; they act on the Browser's tabs only while the focus is
 * in the Browser (src/app/session-cycle.ts chatKeyOwner).
 */
import type { AppCommand } from "./types";

export interface PaneKey {
  command: AppCommand;
  /** `KeyboardEvent.key` in lower case, or the punctuation's physical key. */
  key: string;
  shift: boolean;
  /** Needs Control even on macOS, where the other keys use Command. */
  control?: boolean;
  /** Only on macOS. */
  macOnly?: boolean;
}

const key = (
  command: AppCommand,
  name: string,
  shift = false,
  extra: Partial<Pick<PaneKey, "control" | "macOnly">> = {},
): PaneKey => ({ command, key: name, shift, ...extra });

/** ⌘1 to ⌘9 pick the Browser's tabs (selectBrowserTab1-9). */
const tabCommands = [
  "browser-tab-1",
  "browser-tab-2",
  "browser-tab-3",
  "browser-tab-4",
  "browser-tab-5",
  "browser-tab-6",
  "browser-tab-7",
  "browser-tab-8",
  "browser-tab-9",
] as const satisfies readonly AppCommand[];

export const paneKeys: readonly PaneKey[] = Object.freeze([
  key("toggle-terminal", "j", false, { macOnly: true }),
  key("toggle-terminal", "`", false, { control: true }),
  key("toggle-changes", "d", true),
  key("toggle-browser", "b", true),
  key("toggle-files", "f", true),
  // The app's second Browser key, ⇧⌘P (Ctrl+Shift+P elsewhere); the menu and
  // tooltips keep showing ⇧⌘B.
  key("toggle-browser", "p", true),
  key("toggle-side-chat", ";"),
  key("close-pane", "\\"),
  key("toggle-expand-pane", "\\", true),
  key("browser-select-element", "s", true),
  // ⇧⌘X: sketch on the Browser's page.
  key("browser-sketch", "x", true),
  key("new-browser-tab", "t"),
  key("reopen-closed-session", "t", true),
  key("browser-focus-address", "l"),
  key("browser-next-tab", "tab", false, { control: true }),
  key("browser-previous-tab", "tab", true, { control: true }),
  ...tabCommands.map((command, index) => key(command, String(index + 1))),
]);

/** The parts of a key press the table reads (a DOM event or Electron's input). */
export interface PanePress {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Electron's `Input` names the modifiers like this. */
  meta?: boolean;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** The key a binding names: punctuation by its physical key (Shift changes `key`). */
export function paneKeyName(press: Pick<PanePress, "key" | "code">) {
  if (press.code === "Backquote") return "`";
  if (press.code === "Backslash") return "\\";
  return press.key.toLowerCase();
}

/** The pane command a key press runs on a platform, if any. */
export function paneKeyCommand(
  press: PanePress,
  mac: boolean,
): AppCommand | undefined {
  const meta = press.metaKey ?? press.meta ?? false;
  const ctrl = press.ctrlKey ?? press.control ?? false;
  const shift = press.shiftKey ?? press.shift ?? false;
  const alt = press.altKey ?? press.alt ?? false;
  if (alt) return undefined;
  const name = paneKeyName(press);
  return paneKeys.find((binding) => {
    if (binding.macOnly && !mac) return false;
    if (binding.key !== name || binding.shift !== shift) return false;
    const control = binding.control || !mac;
    return control ? ctrl && !meta : meta && !ctrl;
  })?.command;
}

/**
 * F5 without modifiers: "Reload page in Browser" outside macOS, beside Ctrl+R.
 */
export function pageReloadKey(press: PanePress) {
  const meta = press.metaKey ?? press.meta ?? false;
  const ctrl = press.ctrlKey ?? press.control ?? false;
  const shift = press.shiftKey ?? press.shift ?? false;
  const alt = press.altKey ?? press.alt ?? false;
  return press.key === "F5" && !meta && !ctrl && !shift && !alt;
}
