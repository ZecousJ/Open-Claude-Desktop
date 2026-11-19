import type { KeyboardEvent } from "react";

/** Keyboard context menu (live claude.ai bundle, 2026-10-14, c47a58ae1-BODMtME-). */
export function microphoneContextKey(event: KeyboardEvent<HTMLButtonElement>) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
  )
    return;
  const button = event.currentTarget;
  const bounds = button.getBoundingClientRect();
  const owner = button.ownerDocument.defaultView;
  if (!owner) return;
  if (
    !button.dispatchEvent(
      new owner.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: -1,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      }),
    )
  )
    event.preventDefault();
}
