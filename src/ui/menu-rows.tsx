import { useContext, useEffect, useRef, type KeyboardEvent } from "react";
import { GearIcon } from "./icons";
import { ShortcutPlatform, shortcutText, showsShortcuts } from "./Tooltip";
import { TYPEAHEAD_RESET_MS } from "./menu-keys";
import type { MenuEntry, Item } from "./Menu";

export function MenuValue({ value, label }: { value: string; label?: string }) {
  return (
    <small>
      <span aria-hidden={label ? true : undefined}>{value}</span>
      {label && <span className="sr-only">{label}</span>}
    </small>
  );
}

export const isItem = (entry: MenuEntry): entry is Item => "label" in entry;

/** The settings gear of a row; a click does not select the row. */
export function RowGear({ item, onDone }: { item: Item; onDone: () => void }) {
  if (!item.settings) return null;
  const { label, onSelect } = item.settings;
  return (
    <span
      role="button"
      aria-label={label}
      aria-disabled={item.disabled || undefined}
      className="menu-gear"
      onClick={(event) => {
        event.stopPropagation();
        if (item.disabled) return;
        onDone();
        onSelect();
      }}
    >
      <GearIcon size={16} />
    </span>
  );
}

/** A row's key combination, written for the window's platform. */
export function RowShortcut({ keys }: { keys?: string[] }) {
  const platform = useContext(ShortcutPlatform);
  if (!keys?.length || !showsShortcuts) return null;
  return <kbd>{shortcutText(platform, keys)}</kbd>;
}

export function Decoration({ entry }: { entry: MenuEntry }) {
  return "heading" in entry ? (
    <div className="menu-heading">{entry.heading}</div>
  ) : (
    <hr />
  );
}

/** A typed letter, not a shortcut or a navigation key. */
export const printable = (event: KeyboardEvent) =>
  event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

/** Letters typed in quick succession, forgotten after a pause. */
export function useTypeahead() {
  const state = useRef<{
    text: string;
    timer?: ReturnType<typeof setTimeout>;
  }>({ text: "" });
  useEffect(() => () => clearTimeout(state.current.timer), []);
  return {
    typing: () => state.current.text !== "",
    type(key: string) {
      const current = state.current;
      clearTimeout(current.timer);
      current.text += key;
      current.timer = setTimeout(() => {
        current.text = "";
      }, TYPEAHEAD_RESET_MS);
      return current.text;
    },
  };
}

/**
 * The label a row shows, as typed letters match it: the text on screen,
 * which the interface translation may have changed, else the entry's own.
 */
export function shownLabel(
  container: HTMLElement | null,
  selector: string,
  fallback: string,
) {
  return (
    container?.querySelector(`${selector} > span`)?.textContent ?? fallback
  );
}

/**
 * Moves focus to a row without scrolling the page. A hover only moves it
 * while focus is already in a menu, never out of a field.
 */
export function focusRow(
  container: HTMLElement | null,
  selector: string,
  fromPointer = false,
) {
  if (fromPointer && !document.activeElement?.closest('[role="menu"]')) return;
  container
    ?.querySelector<HTMLElement>(selector)
    ?.focus({ preventScroll: true });
}
