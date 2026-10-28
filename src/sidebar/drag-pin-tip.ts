import type { Mode } from "../../shared/types";
import { collapseWidth } from "./sidebar-visibility";

/**
 * The one-time tip beside Pinned that says rows can be dragged there. Pinning a
 * row from its menu or with the keyboard, while the tip has never been
 * dismissed and the sidebar is open at a normal width, shows it; closing it
 * with its × marks it seen for good. Hiding the sidebar takes the tip away
 * without marking it seen, so the next pin from a menu shows it again.
 */

/** The seen flag, kept with the browser's other per-person sidebar state. */
export const dragPinTipKey = "claudex.sidebar.dragPinTipSeen";

type Store = Pick<Storage, "getItem" | "setItem">;

const storage = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** True once the tip was closed with its ×. */
export function dragPinTipSeen(store: Store | undefined = storage()): boolean {
  try {
    return store?.getItem(dragPinTipKey) === "1";
  } catch {
    return false;
  }
}

export function markDragPinTipSeen(store: Store | undefined = storage()) {
  try {
    store?.setItem(dragPinTipKey, "1");
  } catch {
    // Without storage the tip is gone until the page is loaded again.
  }
}

/**
 * Whether a pin from a row's menu shows the tip: never once it was seen,
 * and only while the sidebar is open as a column (not peeking out while
 * collapsed, not the phone drawer below the collapse width), as the live
 * store's maybeShowDragPinHint refuses a collapsed, narrow or drilled-in
 * sidebar.
 */
export function offersDragPinTip({
  pinning,
  seen,
  sidebarShown,
  width,
}: {
  /** The row is being pinned (not unpinned). */
  pinning: boolean;
  seen: boolean;
  sidebarShown: boolean;
  /** The window's width in CSS pixels. */
  width: number;
}): boolean {
  return pinning && !seen && sidebarShown && width >= collapseWidth();
}

/**
 * The tip's words for the list it sits in: Code's rows are sessions,
 * Cowork's tasks, Chat's chats (the live message's kind select).
 */
export function dragPinTipText(mode: Mode): string {
  return mode === "code"
    ? "Tip: you can drag sessions here to pin them"
    : mode === "cowork"
      ? "Tip: you can drag tasks here to pin them"
      : "Tip: you can drag chats here to pin them";
}
