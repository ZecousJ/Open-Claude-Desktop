import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { AppCommand } from "../../shared/types";
import { surface } from "../../shared/host";
import { commandForKey, keyTable, type KeyTable } from "../host/keys";

/**
 * Next and Previous chat (Ctrl+Tab, Ctrl+Shift+Tab, ⇧⌘] and ⇧⌘[) keep stepping
 * while held, at most one step every 50ms.
 */
export const repeatingCommands: ReadonlySet<AppCommand> = new Set([
  "next-session",
  "previous-session",
  "browser-next-tab",
  "browser-previous-tab",
]);
export const heldStepFloorMs = 50;

/** A field or terminal that keeps its own Control keys. */
function typingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
    (element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.closest?.(".xterm")),
  );
}

/**
 * Whether a key press runs its command: a first press always; a held key's
 * repeat only for the stepping commands, 50ms after their last step. Every
 * other shortcut runs once however long it is held.
 */
export function heldKeyRuns(
  command: AppCommand,
  repeat: boolean,
  sinceLastStepMs: number,
) {
  if (!repeat) return true;
  return repeatingCommands.has(command) && sinceLastStepMs >= heldStepFloorMs;
}

/**
 * The window's keyboard shortcuts run the same commands as the application
 * menu. `disabled` shortcuts are left to the system (a separate
 * conversation window has no sidebar to toggle); it is read once. `table`
 * is the surface's shortcuts (src/host/keys.ts; the web app's differ from
 * the desktop's), read at each key press.
 */
export function useKeyboardCommands(
  runCommand: RefObject<(command: AppCommand) => void>,
  setSearch: Dispatch<SetStateAction<string | null>>,
  disabled?: ReadonlySet<AppCommand>,
  table: KeyTable = keyTable(surface),
) {
  const current = useRef(table);
  current.current = table;
  const lastStep = useRef(0);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const command = commandForKey(e, current.current);
      // Ctrl+B leaves a text field's or a terminal's own Ctrl+B alone.
      if (command === "toggle-background" && typingTarget(e.target)) return;
      if (command && !disabled?.has(command)) {
        e.preventDefault();
        const now = performance.now();
        if (heldKeyRuns(command, e.repeat, now - lastStep.current)) {
          if (repeatingCommands.has(command)) lastStep.current = now;
          runCommand.current(command);
        }
      }
      if (e.key === "Escape") {
        setSearch(null);
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}
