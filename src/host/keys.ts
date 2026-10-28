import type { AppCommand } from "../../shared/types";
import type { HostSurface } from "../../shared/host";
import { paneKeyName, paneKeys } from "../../shared/pane-keys";

/**
 * The window's keyboard shortcuts for each surface. The desktop keeps its
 * table; the web leaves the browser its own shortcuts (⌘N, ⌘T, ⌘W, ⌘L,
 * back and forward, ⌘, for browser settings, Ctrl+Shift+I for developer
 * tools), starts a new chat with ⇧⌘O and opens Settings with ⇧⌘, as
 * claude.ai does
 * (SCRATCH/impl/web/W-UI-design.md §6.4).
 */
export interface KeyBinding {
  command: AppCommand;
  /** `KeyboardEvent.key`, lower case. */
  key: string;
  shift: boolean;
  /**
   * Needs this modifier instead of the table's "mod": Control on macOS for
   * keys the original binds to Control there (Ctrl+` for the terminal,
   * Ctrl+Tab for the browser's tabs), or Alt alone (Back and Forward on
   * Windows and Linux, Alt+← and Alt+→).
   */
  mod?: "ctrl" | "alt";
}

export interface KeyTable {
  surface: HostSurface;
  /**
   * Which key is "mod": the platform's own (Command on macOS, Control
   * elsewhere; the other one is the system's or the text field's, so
   * Control+K still deletes to the line end on a Mac), or either on the
   * desktop before its platform is known.
   */
  mod: "either" | "meta" | "ctrl";
  /** Shortcuts wait while an input method is composing text. */
  skipComposing: boolean;
  bindings: readonly KeyBinding[];
}

const binding = (
  key: string,
  command: AppCommand,
  shift = false,
  mod?: "ctrl" | "alt",
): KeyBinding => ({ key, command, shift, ...(mod ? { mod } : {}) });

/**
 * The desktop's shortcuts. The Code pane keys are shared with the built-in
 * browser's pages (shared/pane-keys.ts). Open File… is ⌘O and Go ▸ Search… ⇧⌘K
 * on macOS.
 */
function desktopBindings(mac: boolean): readonly KeyBinding[] {
  return Object.freeze([
    binding("k", "search"),
    binding("k", "search-palette", true),
    binding("n", "new-chat"),
    binding(",", "settings"),
    binding("b", "toggle-sidebar"),
    binding("/", "shortcuts"),
    // Back and Forward: ⌘[ and ⌘] on macOS, Alt+← and Alt+→ elsewhere; Ctrl+[
    // and Ctrl+] keep working.
    ...(mac
      ? []
      : [
          binding("arrowleft", "back", false, "alt"),
          binding("arrowright", "forward", false, "alt"),
        ]),
    binding("[", "back"),
    binding("]", "forward"),
    // Go ▸ Previous and Next Chat (Ctrl+Tab and ⌘1 to ⌘9, Next chat and
    // Jump to chat, come through the pane keys, whose owner is decided by
    // the focus: src/app/session-cycle.ts).
    binding("[", "previous-session", true),
    binding("]", "next-session", true),
    binding("i", "incognito", true),
    binding("o", "open-file"),
    // File ▸ Open Folder… shows Ctrl/⌘+Shift+O.
    binding("o", "open-folder", true),
    // Background tasks: Ctrl+B. Elsewhere Ctrl+B is already the sidebar's key.
    ...(mac ? [binding("b", "toggle-background", false, "ctrl")] : []),
    ...paneKeys
      .filter((pane) => mac || !pane.macOnly)
      .map((pane) =>
        binding(
          pane.key,
          pane.command,
          pane.shift,
          pane.control ? "ctrl" : undefined,
        ),
      ),
  ]);
}

/** Whether a snapshot platform (or a browser's) is macOS. */
export function isMacPlatform(platform?: string) {
  return platform === "darwin" || /^mac/i.test(platform ?? "");
}

/** The shortcuts of a surface on a platform (`Snapshot.platform`). */
export function keyTable(kind: HostSurface, platform?: string): KeyTable {
  const mac = isMacPlatform(platform);
  if (kind === "desktop")
    return {
      surface: "desktop",
      mod: !platform ? "either" : mac ? "meta" : "ctrl",
      skipComposing: false,
      bindings: desktopBindings(mac),
    };
  return {
    surface: "web",
    mod: mac ? "meta" : "ctrl",
    skipComposing: true,
    bindings: [
      binding("k", "search"),
      // ⇧⌘K opens the palette on Search.
      binding("k", "search-palette", true),
      binding("b", "toggle-sidebar"),
      binding("/", "shortcuts"),
      binding(";", "toggle-side-chat"),
      binding("o", "new-chat", true),
      // ⇧⌘, as claude.ai (⌘, is the browser's own settings).
      binding(",", "settings", true),
      // Ctrl+Shift+I opens the developer tools outside macOS.
      ...(mac ? [binding("i", "incognito", true)] : []),
    ],
  };
}

/** The parts of a keyboard event a shortcut depends on. */
export interface KeyPress {
  key: string;
  /** The physical key: Shift+comma reads "<" as `key` on many layouts. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/** The command a key press runs, if any. */
export function commandForKey(
  press: KeyPress,
  table: KeyTable,
): AppCommand | undefined {
  if (table.skipComposing && press.isComposing) return undefined;
  const modOf = (kind: KeyTable["mod"] | "alt") =>
    kind === "alt"
      ? press.altKey && !press.metaKey && !press.ctrlKey
      : press.altKey
        ? false
        : kind === "either"
          ? press.metaKey || press.ctrlKey
          : kind === "meta"
            ? press.metaKey && !press.ctrlKey
            : press.ctrlKey && !press.metaKey;
  const key = keyOf(press);
  return table.bindings.find(
    (b) =>
      b.key === key && b.shift === press.shiftKey && modOf(b.mod ?? table.mod),
  )?.command;
}

/** The key a binding names: punctuation by its physical key (Shift changes `key`). */
function keyOf(press: KeyPress) {
  if (press.code === "Comma") return ",";
  // Shift types { and } on the brackets' keys.
  if (press.shiftKey && press.code === "BracketLeft") return "[";
  if (press.shiftKey && press.code === "BracketRight") return "]";
  return paneKeyName(press);
}

/**
 * The keys of a command for display (`["mod", "shift", "O"]`, the tokens
 * the Tooltip shortcut labels use), or undefined when the surface has none.
 */
export function shortcutKeys(
  command: AppCommand,
  table: KeyTable,
): string[] | undefined {
  const found = table.bindings.find((b) => b.command === command);
  if (!found) return undefined;
  if (found.mod === "alt")
    return [
      "alt",
      found.key === "arrowleft"
        ? "←"
        : found.key === "arrowright"
          ? "→"
          : found.key.toUpperCase(),
    ];
  return [
    "mod",
    ...(found.shift ? ["shift"] : []),
    found.key.length === 1 ? found.key.toUpperCase() : found.key,
  ];
}
