import type { Conversation, Mode } from "../../shared/types";
import { defaultFilter, pinnedRows, recentRows } from "../sidebar/listFilter";

/**
 * Go ▸ Previous and Next Chat, Task or Session. The original steps through the
 * sidebar's rows as they are drawn, pinned ones first, with one more stop in
 * front of them: the empty new chat, task or session. It wraps at both ends,
 * and from a page that is none of the rows (Settings, a conversation that is
 * not listed) the first step lands on the new chat, as from its stop. The items
 * are enabled whenever the list has a row.
 */

/** Where a step lands: the new conversation, or a listed one. */
export type CycleTarget = { kind: "new" } | { kind: "session"; id: string };

/**
 * The stop one step from `currentId` in `ids` (the list in the sidebar's
 * order). Undefined when the list is empty: there is nothing to cycle.
 */
export function cycleTarget(
  ids: readonly string[],
  currentId: string | undefined,
  direction: 1 | -1,
): CycleTarget | undefined {
  if (ids.length === 0) return undefined;
  const stops = ids.length + 1;
  const found = currentId === undefined ? -1 : ids.indexOf(currentId);
  // Stop 0 is the new conversation; the rows follow it.
  const next = (found + 1 + direction + stops) % stops;
  return next === 0 ? { kind: "new" } : { kind: "session", id: ids[next - 1] };
}

/**
 * The rows of the sidebar's lists in the order they are drawn when no
 * filter or grouping is set: the pinned rows, then the recent ones. Used
 * when the sidebar is not on screen to read the order from.
 */
export function listedIds(conversations: Conversation[], mode: Mode) {
  const visible = conversations.filter((c) => !c.incognito);
  return [
    ...pinnedRows(visible, mode),
    ...recentRows(visible, mode, defaultFilter),
  ].map((c) => c.id);
}

/**
 * The conversation ids of the rows the sidebar draws now, top to bottom, so
 * the filter, the grouping, collapsed sections and rows held back behind
 * "Show more" count the way the person sees them. Empty when the sidebar
 * is closed or has no rows.
 */
export function drawnIds(root: Pick<ParentNode, "querySelectorAll">) {
  const ids = new Set<string>();
  for (const row of root.querySelectorAll<HTMLElement>(
    ".sidebar-scroll [data-conversation-id]",
  ))
    if (row.dataset.conversationId) ids.add(row.dataset.conversationId);
  return [...ids];
}

/**
 * ⌘1 to ⌘9 (Ctrl elsewhere), "Jump to chat" or "Jump to session": the sidebar's
 * row with that number, counted as cycling counts them. Undefined when the list
 * is shorter or that row is already open.
 */
export function jumpTarget(
  ids: readonly string[],
  currentId: string | undefined,
  number: number,
): string | undefined {
  if (!Number.isInteger(number) || number < 1 || number > 9) return undefined;
  const id = ids[number - 1];
  return id === currentId ? undefined : id;
}

/**
 * Who Ctrl+Tab, Ctrl+Shift+Tab and ⌘1 to ⌘9 belong to: the Browser pane listens
 * for its tab keys on the pane itself, so they switch its tabs only while the
 * focus is in the pane (its tab strip, address bar or page); everywhere else
 * the same keys switch chats. A focused select, combobox, listbox or
 * application widget keeps the keys for itself.
 */
export type ChatKeyOwner = "browser" | "chats" | "none";

export function chatKeyOwner(focus: {
  /** The focus is in the Browser pane's own controls. */
  inBrowserPane: boolean;
  /** The Browser's page has the focus (its keys come from the main process). */
  inBrowserPage: boolean;
  /** The focus is in a select, combobox, listbox or application widget. */
  inPicker: boolean;
}): ChatKeyOwner {
  if (focus.inBrowserPane || focus.inBrowserPage) return "browser";
  return focus.inPicker ? "none" : "chats";
}

/** `chatKeyOwner`'s facts, read from the window's document. */
export function focusForChatKeys(
  doc: Pick<Document, "activeElement" | "hasFocus">,
  browserOpen: boolean,
) {
  const active = doc.activeElement as Element | null;
  const within = (selector: string) =>
    Boolean(
      active && typeof active.closest === "function"
        ? active.closest(selector)
        : null,
    );
  return {
    inBrowserPane: within(".browser-panel"),
    // The Browser's page is a view of its own: while it has the focus the
    // window's document has none.
    inBrowserPage: browserOpen && !doc.hasFocus(),
    inPicker: within(
      'select,[role="combobox"],[role="listbox"],[role="application"]',
    ),
  };
}
