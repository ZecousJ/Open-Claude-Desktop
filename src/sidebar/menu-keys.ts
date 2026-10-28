import type { KeyboardEvent } from "react";

/**
 * The menu keys of a popup of `[role="menuitem"]` rows: ↓ ↑ Home End walk the
 * rows and loop, and Tab, which would leave a popup rendered apart from the
 * sidebar, goes to `onTab` (the popup closes). Menu items show the keyboard
 * highlight through `:focus-visible`.
 */
export function roamMenuItems(
  event: KeyboardEvent<HTMLElement>,
  onTab?: () => void,
) {
  if (event.key === "Tab" && onTab) {
    event.preventDefault();
    return onTab();
  }
  const items = menuItems(event.currentTarget);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const next =
    event.key === "ArrowDown"
      ? at < last
        ? at + 1
        : 0
      : event.key === "ArrowUp"
        ? at > 0
          ? at - 1
          : last
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  items[next].focus();
}

/** The popup's rows, in order. */
export const menuItems = (popup: ParentNode) => [
  ...popup.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
