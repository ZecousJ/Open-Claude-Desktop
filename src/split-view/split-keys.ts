import type { AppCommand } from "../../shared/types";

/**
 * The split view's keys (source: ion bundle 2.31226.1, the pane shortcuts,
 * and the desktop View menu): Ctrl+] and Ctrl+[ focus the next and previous
 * pane on every platform; the rest add Command with Control on macOS and
 * Alt with Control elsewhere. Control+\ opens a new session on the right and
 * Control+- below, Control+W closes the focused pane and the arrows move the
 * focus to the neighbouring pane.
 */
export interface SplitPress {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Whether AltGraph is down (Ctrl+Alt on many layouts types a letter). */
  altGraph?: boolean;
}

export type SplitKeyCommand = Extract<
  AppCommand,
  | "split-new-right"
  | "split-new-below"
  | "split-focus-next"
  | "split-focus-previous"
  | "split-close"
  | "split-focus-left"
  | "split-focus-right"
  | "split-focus-up"
  | "split-focus-down"
>;

const arrows: Record<string, SplitKeyCommand> = {
  ArrowLeft: "split-focus-left",
  ArrowRight: "split-focus-right",
  ArrowUp: "split-focus-up",
  ArrowDown: "split-focus-down",
};

/** The split command a key press runs on a platform, if any. */
export function splitKeyCommand(
  press: SplitPress,
  mac: boolean,
): SplitKeyCommand | undefined {
  if (!press.ctrlKey || press.shiftKey) return undefined;
  // Ctrl+] and Ctrl+[ stand alone.
  if (!press.metaKey && !press.altKey) {
    if (press.code === "BracketRight" || press.key === "]")
      return "split-focus-next";
    if (press.code === "BracketLeft" || press.key === "[")
      return "split-focus-previous";
    return undefined;
  }
  // The others: Control with Command (macOS) or with Alt (elsewhere).
  const chord = mac
    ? press.metaKey && !press.altKey
    : press.altKey && !press.metaKey && !press.altGraph;
  if (!chord) return undefined;
  if (press.code === "Backslash") return "split-new-right";
  if (press.code === "Minus") return "split-new-below";
  if (press.code === "KeyW") return "split-close";
  return press.code ? arrows[press.code] : undefined;
}
