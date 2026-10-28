import { useSyncExternalStore } from "react";

/**
 * The terminal's view settings and the default shell, kept per browser profile
 * as the original keeps them.
 */
export type CursorStyle = "block" | "bar" | "underline";
export const cursorStyles: CursorStyle[] = ["block", "bar", "underline"];
export const scrollbacks = [1000, 5000, 10000] as const;

export interface TerminalPrefs {
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  scrollback: number;
  /** The shell a new tab starts with ("" for this computer's own). */
  defaultShell: string;
}

const defaults: TerminalPrefs = {
  cursorStyle: "block",
  cursorBlink: true,
  copyOnSelect: false,
  scrollback: 10000,
  defaultShell: "",
};
const key = "claudex-terminal-prefs";
const listeners = new Set<() => void>();

function read(): TerminalPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    return {
      cursorStyle: cursorStyles.includes(raw.cursorStyle)
        ? raw.cursorStyle
        : defaults.cursorStyle,
      cursorBlink:
        typeof raw.cursorBlink === "boolean"
          ? raw.cursorBlink
          : defaults.cursorBlink,
      copyOnSelect:
        typeof raw.copyOnSelect === "boolean"
          ? raw.copyOnSelect
          : defaults.copyOnSelect,
      scrollback: (scrollbacks as readonly number[]).includes(raw.scrollback)
        ? raw.scrollback
        : defaults.scrollback,
      defaultShell:
        typeof raw.defaultShell === "string" ? raw.defaultShell : "",
    };
  } catch {
    return defaults;
  }
}
let current = read();

export function setTerminalPrefs(patch: Partial<TerminalPrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    // Kept for this window only.
  }
  listeners.forEach((listener) => listener());
}

export function terminalPrefs() {
  return current;
}

export function useTerminalPrefs() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => defaults,
  );
}
