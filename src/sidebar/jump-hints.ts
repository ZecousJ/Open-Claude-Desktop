import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The sidebar's row numbers: holding ⌘ (Ctrl outside macOS) on the desktop, or
 * Ctrl+Shift on any surface, for 200ms numbers the first nine rows the sidebar
 * shows, 1 to 9, on the rows' leading slots. ⌘1…9 then opens the numbered row,
 * and so does Ctrl+Shift+1…9. The numbers go when the keys are let go, another
 * key is pressed, the pointer moves or clicks without the keys, the window
 * loses the focus or is hidden; they never show while a text field, select or
 * text area has the focus.
 */

/** How long the keys are held before the numbers show. */
export const jumpHintDelayMs = 200;
/** The digits, in row order. */
export const jumpHintDigits = "123456789";

/** The modifier state a key, pointer or wheel event carries. */
export interface HintPress {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Ctrl+Shift alone: the numbers' chord on every surface. */
export function holdsCtrlShift(press: HintPress) {
  return press.ctrlKey && press.shiftKey && !press.metaKey && !press.altKey;
}

/** ⌘ alone on macOS, Ctrl alone elsewhere: the desktop's chord. */
export function holdsJumpMod(press: HintPress, mac: boolean) {
  const mod = mac ? press.metaKey : press.ctrlKey;
  const other = mac ? press.ctrlKey : press.metaKey;
  return mod && !other && !press.shiftKey && !press.altKey;
}

/** Whether the keys held keep (or start) the numbers. */
export function holdsHintChord(
  press: HintPress,
  { desktop, mac }: { desktop: boolean; mac: boolean },
) {
  return holdsCtrlShift(press) || (desktop && holdsJumpMod(press, mac));
}

const modifierKeys = new Set(["Shift", "Control", "Meta"]);

/** A key that is only a modifier of the chord. */
export function isHintModifier(key: string) {
  return modifierKeys.has(key);
}

/**
 * The digit or letter a key press stands for (by the physical key, so
 * Shift+1 is still 1); null for any other key.
 */
export function hintKeyOf(press: { key: string; code?: string }) {
  if (press.code?.startsWith("Digit")) return press.code.slice(5);
  const key = press.key.toLowerCase();
  const letter = key.length === 1 && key >= "a" && key <= "z";
  if (press.code?.startsWith("Key"))
    return letter ? key : press.code.slice(3).toLowerCase();
  return letter ? key : null;
}

/** A row the sidebar draws: its id and whether it is on screen. */
interface HintRow {
  dataset: { conversationId?: string };
  offsetParent?: unknown;
}

/**
 * The ids of the rows the sidebar shows now, top to bottom, once each:
 * rows inside a closed section or otherwise not laid out are skipped.
 */
export function shownRowIds(
  root: Pick<ParentNode, "querySelectorAll">,
  limit = jumpHintDigits.length,
) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of root.querySelectorAll(
    ".sidebar-scroll [data-conversation-id]",
  ) as unknown as Iterable<HintRow>) {
    const id = row.dataset.conversationId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (row.offsetParent === null) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** The numbers of the rows: row id → digit. */
export function hintsFor(ids: readonly string[]): Record<string, string> {
  const hints: Record<string, string> = {};
  ids.slice(0, jumpHintDigits.length).forEach((id, index) => {
    hints[id] = jumpHintDigits[index];
  });
  return hints;
}

/** The row a digit names while the numbers show. */
export function rowForDigit(
  hints: Record<string, string> | null,
  digit: string,
): string | undefined {
  if (!hints) return undefined;
  return Object.keys(hints).find((id) => hints[id] === digit);
}

let shown: Record<string, string> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function setShown(next: Record<string, string> | null) {
  if (next === shown) return;
  shown = next;
  listeners.forEach((listener) => listener());
}

/** The numbers on screen now, or null. */
export function shownJumpHints() {
  return shown;
}

/** Numbers the rows the sidebar shows; nothing when it shows none. */
export function showJumpHints(root: Pick<ParentNode, "querySelectorAll">) {
  const ids = shownRowIds(root);
  if (ids.length) setShown(hintsFor(ids));
}

export function hideJumpHints() {
  if (shown !== null) setShown(null);
}

/** One row's number while the numbers show. */
export function useJumpHint(id: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => shown?.[id] ?? null,
    () => null,
  );
}

/** A text field, select or text area has the focus: no numbers. */
function typing(doc: Document) {
  const active = doc.activeElement;
  if (!active) return false;
  return (
    active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.tagName === "SELECT"
  );
}

/**
 * Watches the keys for the row numbers and Ctrl+Shift+1…9. `onJump` opens
 * a row by its id. Off while `enabled` is false (an incognito chat on
 * screen, a window without the sidebar list).
 */
export function useJumpHints({
  enabled,
  desktop,
  mac,
  onJump,
}: {
  enabled: boolean;
  desktop: boolean;
  mac: boolean;
  onJump: (id: string) => void;
}) {
  const jump = useRef(onJump);
  jump.current = onJump;
  useEffect(() => {
    if (!enabled) {
      hideJumpHints();
      return;
    }
    const chord = { desktop, mac };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      cancel();
      hideJumpHints();
    };
    const arm = () => {
      if (shown !== null || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (typing(document) || !document.hasFocus()) return;
        showJumpHints(document);
      }, jumpHintDelayMs);
    };
    const keydown = (event: KeyboardEvent) => {
      if (!holdsHintChord(event, chord)) return hide();
      if (typing(document)) return cancel();
      if (!isHintModifier(event.key)) cancel();
      if (event.defaultPrevented || event.repeat) return;
      if (isHintModifier(event.key)) return arm();
      const key = hintKeyOf(event);
      if (key === null) return;
      if (!jumpHintDigits.includes(key)) return hide();
      // ⌘1…9 belong to the window's keys (Jump to chat); Ctrl+Shift+1…9
      // are the numbers' own.
      if (!holdsCtrlShift(event)) return;
      if (shown === null) showJumpHints(document);
      const id = rowForDigit(shown, key);
      if (id === undefined) return hide();
      event.preventDefault();
      hide();
      jump.current(id);
    };
    const keyup = (event: KeyboardEvent) => {
      if (!holdsHintChord(event, chord)) hide();
      else arm();
    };
    const pointer = (event: MouseEvent) => {
      if (shown === null && timer === null) return;
      if (!holdsHintChord(event, chord)) hide();
    };
    const visibility = () => hide();
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", hide);
    window.addEventListener("mousemove", pointer);
    window.addEventListener("mousedown", pointer);
    window.addEventListener("wheel", pointer, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", hide);
      window.removeEventListener("mousemove", pointer);
      window.removeEventListener("mousedown", pointer);
      window.removeEventListener("wheel", pointer);
      document.removeEventListener("visibilitychange", visibility);
      hide();
    };
  }, [enabled, desktop, mac]);
}
