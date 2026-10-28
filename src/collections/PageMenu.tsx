import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "../ui/glyphs";
import { useDismiss } from "../ui/useDismiss";
import { showsShortcuts } from "../ui/Tooltip";
import "./collections.css";

export type PageMenuEntry =
  | { separator: true }
  | { heading: string }
  | {
      label: string;
      icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
      checked?: boolean;
      checkedRole?: "radio" | "checkbox";
      danger?: boolean;
      disabled?: boolean;
      /** Why the row is disabled, as its tooltip. */
      title?: string;
      /** A single key shown on the right; pressing it while the menu is open selects the row. */
      hint?: string;
      onSelect: () => void;
    };
type Item = Extract<PageMenuEntry, { label: string }>;
const isItem = (entry: PageMenuEntry): entry is Item => "label" in entry;

/**
 * The page menus of Customize: 32px rows with 14px text and optional 16px
 * icons, a 4px frame, opening 7px under the trigger and right-aligned with it.
 * The sidebar-sized `ui/Menu` has 24px rows.
 */
export function PageMenu({
  label,
  entries,
  anchor,
  width,
  onClose,
}: {
  label: string;
  entries: PageMenuEntry[];
  /** The trigger: the menu lines up under it and its clicks toggle. */
  anchor: RefObject<HTMLElement | null>;
  width: number;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useDismiss([box, anchor], true, onClose);
  useLayoutEffect(() => {
    const trigger = anchor.current?.getBoundingClientRect();
    const own = box.current?.getBoundingClientRect();
    if (!trigger || !own) return;
    // 6px from its trigger.
    const below = trigger.bottom + 6;
    setPlace({
      left: Math.max(
        8,
        Math.min(trigger.right - width, innerWidth - width - 8),
      ),
      top:
        below + own.height > innerHeight - 8
          ? Math.max(8, trigger.top - own.height - 6)
          : below,
    });
  }, []);
  useEffect(() => box.current?.focus(), []);
  const selectable = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isItem(entry) && !entry.disabled);
  const choose = (item: Item) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!selectable.length) return;
      const at = selectable.findIndex(({ index }) => index === active);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(
        selectable[(at + step + selectable.length) % selectable.length].index,
      );
    } else if (event.key === "Enter" || event.key === " ") {
      const entry = entries[active];
      if (entry && isItem(entry)) {
        event.preventDefault();
        choose(entry);
      }
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const hit = entries.find(
        (entry): entry is Item =>
          isItem(entry) &&
          !entry.disabled &&
          entry.hint?.toLowerCase() === event.key.toLowerCase(),
      );
      if (hit) {
        event.preventDefault();
        choose(hit);
      }
    } else if (event.key === "Escape") {
      // Only the menu closes: the window's own Escape would also close ⌘K
      // under a search row's menu.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return createPortal(
    <div
      ref={box}
      className="page-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ width, ...(place ?? { left: -9999, top: 0 }) }}
      onKeyDown={keyDown}
    >
      {entries.map((entry, index) =>
        isItem(entry) ? (
          <button
            key={index}
            type="button"
            role={
              entry.checked === undefined
                ? "menuitem"
                : entry.checkedRole === "checkbox"
                  ? "menuitemcheckbox"
                  : "menuitemradio"
            }
            aria-checked={entry.checked}
            disabled={entry.disabled}
            title={entry.title}
            className={`${active === index ? "active" : ""} ${entry.danger ? "danger" : ""}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(entry)}
          >
            {entry.icon && <entry.icon size={18} strokeWidth={1.75} />}
            <span>{entry.label}</span>
            {entry.checked && <Check size={16} className="page-menu-check" />}
            {entry.hint && showsShortcuts && <kbd>{entry.hint}</kbd>}
          </button>
        ) : "heading" in entry ? (
          <div key={index} className="page-menu-heading">
            {entry.heading}
          </div>
        ) : (
          <hr key={index} />
        ),
      )}
    </div>,
    document.body,
  );
}
