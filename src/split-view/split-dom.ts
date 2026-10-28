/** How many frames a new pane gets to appear before the focus gives up on it. */
const frames = 30;

/**
 * Puts the keyboard in a pane's composer (a pane that was just opened may
 * still be loading, so it is looked for over a few frames). The primary pane
 * is 0.
 */
export function focusPaneComposer(index: number, left = frames) {
  const pane = document.querySelector<HTMLElement>(
    `[data-pane-index="${index}"]`,
  );
  const field = pane?.querySelector<HTMLElement>("textarea:not([disabled])");
  if (field) {
    field.focus();
    return;
  }
  if (left > 0) requestAnimationFrame(() => focusPaneComposer(index, left - 1));
}
