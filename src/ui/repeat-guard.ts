/*
 * A held Enter does not press a button again and again. The original's Button,
 * Switch, Checkbox and confirmation buttons swallow the auto-repeat of Enter
 * and Space, so holding Enter on a dialog's focused confirm button deletes
 * once, and holding it on a switch does not flip it back and forth. Done once
 * for the whole window rather than control by control.
 */

/** What can be pressed with Enter or Space and must act once per press. */
const PRESSABLE =
  'button, [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], summary';

/**
 * True for the auto-repeat of Enter or Space on a pressable control: the
 * keydown whose default action would activate it again.
 */
export function isRepeatPress(event: {
  key: string;
  repeat: boolean;
  target: EventTarget | null;
}): boolean {
  if (!event.repeat) return false;
  if (event.key !== "Enter" && event.key !== " ") return false;
  // The focused element itself, not one inside a button-like container (a
  // field in a row would lose its repeating spaces).
  const target = event.target as Element | null;
  return typeof target?.matches === "function" && target.matches(PRESSABLE);
}

/** Starts the window-wide guard; call once at start-up. */
export function installRepeatGuard() {
  document.addEventListener(
    "keydown",
    (event) => {
      if (isRepeatPress(event)) event.preventDefault();
    },
    true,
  );
}
