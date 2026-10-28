import type { MenuEntry } from "../ui/Menu";

/**
 * What Attach selection as context takes from the terminal: the selection
 * without the blanks around it, or nothing when only blanks are selected.
 */
export function attachableSelection(selection: string) {
  const text = selection.trim();
  return text || undefined;
}

/**
 * The terminal's own keys, shown in its menu: Attach selection as context ⇧⌘L
 * (Ctrl+Shift+L elsewhere); Copy and Paste ⌘C and ⌘V on macOS, Ctrl+Shift+C and
 * Ctrl+Shift+V elsewhere, where Ctrl+C and Ctrl+V go to the shell; Select all
 * ⌘A on macOS only.
 */
export function terminalShortcuts(mac: boolean) {
  return {
    attach: ["shift", "mod", "L"],
    copy: mac ? ["mod", "C"] : ["ctrl", "shift", "C"],
    paste: mac ? ["mod", "V"] : ["ctrl", "shift", "V"],
    selectAll: mac ? ["mod", "A"] : undefined,
  };
}

/** The parts of a key press `terminalKey` reads. */
export interface TerminalKeyPress {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Which of the menu's keys a press in the terminal is, for the keys xterm
 * does not handle itself: Attach selection as context everywhere, and Copy
 * and Paste off macOS (xterm already copies, pastes and selects all with
 * ⌘C, ⌘V and ⌘A on macOS).
 */
export function terminalKey(
  press: TerminalKeyPress,
  mac: boolean,
): "attach" | "copy" | "paste" | undefined {
  if (press.type !== "keydown" || press.altKey || !press.shiftKey) return;
  const mod = mac
    ? press.metaKey && !press.ctrlKey
    : press.ctrlKey && !press.metaKey;
  if (!mod) return;
  const key = press.key.toLowerCase();
  if (key === "l") return "attach";
  if (mac) return;
  if (key === "c") return "copy";
  if (key === "v") return "paste";
}

/**
 * The terminal canvas's right-click menu: Attach selection as context (only
 * while the selection has text, followed by a separator), Copy (greyed
 * without a selection), Paste, Select all and Clear terminal, in the
 * original's order, each with its keys.
 */
export function terminalCanvasMenu(
  selection: string,
  actions: {
    /** Left out where nothing can take the context: the item is not offered. */
    attach?: (text: string) => void;
    copy: (text: string) => void;
    paste: () => void;
    selectAll: () => void;
    clear: () => void;
  },
  mac = true,
): MenuEntry[] {
  const attachable = attachableSelection(selection);
  const { attach } = actions;
  const keys = terminalShortcuts(mac);
  return [
    ...(attachable && attach
      ? [
          {
            label: "Attach selection as context",
            shortcut: keys.attach,
            onSelect: () => attach(attachable),
          },
          { separator: true as const },
        ]
      : []),
    {
      label: "Copy",
      shortcut: keys.copy,
      disabled: !selection,
      onSelect: () => actions.copy(selection),
    },
    { label: "Paste", shortcut: keys.paste, onSelect: actions.paste },
    { separator: true },
    {
      label: "Select all",
      shortcut: keys.selectAll,
      onSelect: actions.selectAll,
    },
    { separator: true },
    { label: "Clear terminal", onSelect: actions.clear },
  ];
}
