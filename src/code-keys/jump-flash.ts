/**
 * Lights a transcript row up for a moment where a jump landed: the 10% ink wash
 * fades out over 1.2s. Used by the prompt jump keys.
 */
export function flashJumpTarget(element: Element) {
  element.classList.remove("code-jump-flash");
  // Restart the animation when the same row is jumped to twice.
  void (element as HTMLElement).offsetWidth;
  element.classList.add("code-jump-flash");
  element.addEventListener(
    "animationend",
    () => element.classList.remove("code-jump-flash"),
    { once: true },
  );
}
