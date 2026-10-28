import { useSyncExternalStore } from "react";

/**
 * The sidebar's multi-select: ⌘ or Ctrl-click toggles a row, Shift-click
 * selects the range from the last row clicked, and a plain click clears the
 * selection. A selection stays inside one domain (a section of the list): a
 * toggle or a range that starts in another domain starts over there.
 */
export type SelectionState = {
  keys: ReadonlySet<string>;
  anchor: string | null;
  domain: string;
};

const empty: ReadonlySet<string> = new Set();
let state: SelectionState = { keys: empty, anchor: null, domain: "" };
const listeners = new Set<() => void>();

function set(next: SelectionState) {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
}

const otherDomain = (domain: string) =>
  state.keys.size > 0 && state.domain !== domain;

export const selection = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  toggle(key: string, domain = "") {
    const keys = new Set(state.keys);
    if (keys.has(key)) {
      keys.delete(key);
      return set({ ...state, keys, anchor: key });
    }
    if (otherDomain(domain))
      return set({ keys: new Set([key]), anchor: key, domain });
    keys.add(key);
    set({ keys, anchor: key, domain });
  },
  /** From the anchor (or `key` itself) to `key`, along `order`. */
  selectRange(key: string, order: readonly string[], domain = "") {
    const anchor = state.anchor ?? key;
    const from = otherDomain(domain) ? -1 : order.indexOf(anchor);
    const to = order.indexOf(key);
    if (from === -1 || to === -1)
      return set({ keys: new Set([key]), anchor: key, domain });
    const [start, end] = from < to ? [from, to] : [to, from];
    set({ keys: new Set(order.slice(start, end + 1)), anchor, domain });
  },
  /** Drops keys that are gone (deleted, or no longer listed). */
  prune(gone: Iterable<string>) {
    const drop = new Set(gone);
    const keys = new Set([...state.keys].filter((key) => !drop.has(key)));
    const anchor =
      state.anchor !== null && drop.has(state.anchor) ? null : state.anchor;
    if (keys.size === state.keys.size && anchor === state.anchor) return;
    set({ ...state, keys: keys.size ? keys : empty, anchor });
  },
  clear() {
    if (state.keys.size === 0 && state.anchor === null) return;
    set({ keys: empty, anchor: null, domain: "" });
  },
};

/** A plain click clears the selection; ⌘, Ctrl or Shift keep it. */
export function clearUnlessModified(event?: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}) {
  if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) return;
  selection.clear();
}

/**
 * A menu opened on a row that is not in the selection, or a single-row
 * menu over a selection of several, lets the selection go first.
 */
export function clearForMenu(key: string, single = false) {
  const { keys } = selection.get();
  if ((keys.size > 0 && !keys.has(key)) || (single && keys.size > 1))
    selection.clear();
}

export function useSelected(key: string) {
  return useSyncExternalStore(
    selection.subscribe,
    () => selection.get().keys.has(key),
    () => false,
  );
}

export function useSelection() {
  return useSyncExternalStore(
    selection.subscribe,
    selection.get,
    selection.get,
  );
}

/** The domain a row's selection lives in: its section of the list. */
export function domainOf(element: Element) {
  return (
    element.closest("[data-drop-section]")?.getAttribute("data-drop-section") ??
    ""
  );
}

/** The rows of the element's section, in the order they show. */
export function rowOrder(element: Element) {
  const section = element.closest("[data-drop-section]");
  if (!section) return [];
  return [...section.querySelectorAll<HTMLElement>("[data-conversation-id]")]
    .filter((row) => row.offsetParent !== null)
    .map((row) => row.dataset.conversationId!)
    .filter(Boolean);
}
