import type { MenuEntry } from "../ui/Menu";
import { notAvailable } from "../settings/unavailable";
import { terminalShortcuts } from "../terminal/terminal-menu";

/**
 * What Attach selection as context takes from a message: the selection once it
 * has two characters or more after trimming; a shorter one is ignored and the
 * whole message goes instead.
 */
export function messageSelection(selection: string) {
  const text = selection.trim();
  return text.length >= 2 ? text : undefined;
}

/**
 * A Code prompt bubble's right-click menu, in the original's order: Copy
 * message, Copy message as Markdown, a separator, Attach selection / message as
 * context, Pin as chapter (greyed: Claudex has no chapters), a separator, then
 * Rewind to here and Fork from here. The attach item reads "selection" and
 * shows the terminal's ⇧⌘L only while the bubble has a selection.
 */
export function codeMessageMenu(options: {
  copy: () => void;
  /** Left out where nothing can take the context: the item is not offered. */
  onAttach?: () => void;
  selection?: string;
  onRewind?: () => void;
  rewindReason?: string;
  onFork?: () => void;
  mac?: boolean;
}): MenuEntry[] {
  const { onAttach, onRewind, onFork } = options;
  const entries: MenuEntry[] = [
    { label: "Copy message", onSelect: options.copy },
    { label: "Copy message as Markdown", onSelect: options.copy },
  ];
  // Pin as chapter has no Claudex counterpart yet: it stays in its place,
  // greyed.
  const pin = Boolean(onRewind || onFork);
  if (onAttach || pin) entries.push({ separator: true });
  if (onAttach) {
    const selected = Boolean(options.selection);
    entries.push({
      label: selected
        ? "Attach selection as context"
        : "Attach message as context",
      ...(selected
        ? { shortcut: terminalShortcuts(options.mac ?? true).attach }
        : {}),
      onSelect: onAttach,
    });
  }
  if (pin)
    entries.push({
      label: "Pin as chapter",
      disabled: true,
      title: notAvailable,
    });
  if (pin) entries.push({ separator: true });
  if (onRewind)
    entries.push({
      label: "Rewind to here",
      description: "Removes this message and what follows",
      disabled: Boolean(options.rewindReason),
      ...(options.rewindReason ? { title: options.rewindReason } : {}),
      onSelect: onRewind,
    });
  if (onFork)
    entries.push({
      label: "Fork from here",
      description: "Starts a new session, keeps this one",
      onSelect: onFork,
    });
  return entries;
}
