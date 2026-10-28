import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check } from "./glyphs";
import { formatText } from "../i18n";
import { ReasonTooltip, showsShortcuts } from "./Tooltip";
import { itemRole, stepPosition, typeaheadPosition } from "./menu-keys";
import { useEscapeLayer } from "./useDismiss";
import {
  MenuValue,
  isItem,
  RowGear,
  RowShortcut,
  Decoration,
  printable,
  useTypeahead,
  shownLabel,
  focusRow,
} from "./menu-rows";
import type { MenuEntry, Item, MenuSize } from "./Menu";

/**
 * A searchable submenu's rows with its create row: "New project" and a rule on
 * top while nothing is typed, "Create project {name}" at the end once something
 * is.
 */
export function withCreateRow(
  entries: MenuEntry[],
  create: Item["searchCreate"],
  name: string,
): MenuEntry[] {
  if (!create) return entries;
  if (name)
    return [
      ...entries,
      {
        label: formatText(create.typed, { name }),
        noTranslate: true,
        onSelect: () => create.onSelect(name),
      },
    ];
  return [
    { label: create.idle, onSelect: () => create.onSelect("") },
    { separator: true },
    ...entries,
  ];
}

/** A second-level list; the first checked row starts highlighted. */
export function Submenu({
  ref,
  size,
  className,
  label,
  entries: listed,
  header,
  searchable,
  searchEmpty = "No matches",
  searchCreate,
  left,
  top,
  flipRight,
  focusOnOpen,
  onArrive,
  onLeave,
  onBack,
  onDone,
}: {
  ref: RefObject<HTMLDivElement | null>;
  size: MenuSize;
  className?: string;
  label: string;
  entries: MenuEntry[];
  /** Optional persistent submenu navigation, before the searchable rows. */
  header?: ReactNode;
  /** The search field's placeholder, when the submenu has one. */
  searchable?: string;
  searchEmpty?: string;
  searchCreate?: Item["searchCreate"];
  left: number;
  top: number;
  /**
   * Where the submenu's right edge sits when the window has no room on the
   * parent menu's right and it opens on the left instead.
   */
  flipRight?: number;
  /** Opened from the keyboard: its highlighted row takes focus. */
  focusOnOpen: boolean;
  /** The pointer reached the submenu. */
  onArrive: () => void;
  /** The pointer left the submenu. */
  onLeave?: (event: PointerEvent) => void;
  /** Escape or ←: closes this level only, back on its row. */
  onBack: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState({ left, top });
  // Inside the window: on the parent's left when there is no room on its right,
  // and moved up when its rows would run past the bottom.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const x =
      left + rect.width > window.innerWidth - margin && flipRight !== undefined
        ? Math.max(margin, flipRight - rect.width)
        : left;
    const y = Math.max(
      margin,
      Math.min(top, window.innerHeight - rect.height - margin),
    );
    setPlace((now) =>
      now.left === x && now.top === y ? now : { left: x, top: y },
    );
  }, [left, top, flipRight]);
  // Escape closes this level alone, wherever focus is.
  useEscapeLayer(true, () => onBack());
  // A search keeps the rows whose label has the typed text; rules and
  // headings go while it narrows.
  const needle = query.trim().toLocaleLowerCase();
  const entries = withCreateRow(
    needle
      ? listed.filter(
          (entry) =>
            isItem(entry) && entry.label.toLocaleLowerCase().includes(needle),
        )
      : listed,
    searchCreate,
    query.trim(),
  );
  const nothingListed = !listed.some(isItem);
  const items = entries.filter(isItem);
  // Arrows, Home/End and typed letters skip the greyed rows, as the first
  // level does.
  const enabled = items
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => !item.disabled);
  const [active, setActive] = useState(() => {
    const checked = items.findIndex((item) => item.checked && !item.disabled);
    return checked >= 0
      ? checked
      : Math.max(
          0,
          items.findIndex((item) => !item.disabled),
        );
  });
  const typeahead = useTypeahead();
  const highlight = (position: number, fromPointer = false) => {
    setActive(position);
    focusRow(ref.current, `[data-position="${position}"]`, fromPointer);
  };
  useEffect(() => {
    if (!focusOnOpen) return;
    if (searchable) search.current?.focus();
    else if (items[active]?.disabled) ref.current?.focus();
    else highlight(active);
  }, []);
  // The first match is the one Enter takes.
  const typed = useRef(false);
  useEffect(() => {
    if (searchable && typed.current) setActive(enabled[0]?.position ?? 0);
    typed.current = true;
  }, [needle]);
  const pick = (item: Item | undefined) => {
    // A disabled row (e.g. an environment Claudex cannot reach yet) stays
    // visible with its reason as a tooltip, but does nothing.
    if (!item || item.disabled) return;
    if (!item.keepOpen) onDone();
    item.onSelect?.();
  };
  let row = -1;
  return (
    <div
      ref={ref}
      className={`menu u-scroll-fade-y ${size}${className ? ` ${className}` : ""}`}
      data-submenu=""
      data-searchable={searchable !== undefined ? "" : undefined}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={place}
      onMouseEnter={(event) => event.stopPropagation()}
      onPointerEnter={onArrive}
      onPointerLeave={onLeave}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          // As in the first level: the whole menu closes.
          event.preventDefault();
          onDone();
          return;
        }
        if (
          event.repeat &&
          (event.key === "Enter" || (event.key === " " && !typeahead.typing()))
        ) {
          event.preventDefault();
          return;
        }
        // In the search field the text keys, Space and the horizontal arrows
        // belong to the field; ↓ and ↑ go to the rows.
        const typing =
          searchable !== undefined && event.target === search.current;
        if (
          typing &&
          (event.key === "Home" ||
            event.key === "End" ||
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === " ")
        )
          return;
        const current = enabled.findIndex(
          ({ position }) => position === active,
        );
        const step = stepPosition(event.key, current, enabled.length);
        if (step !== undefined) {
          event.preventDefault();
          if (!typing) highlight(enabled[step].position);
          else if (event.key === "ArrowDown")
            highlight(
              (enabled.find(({ position }) => position >= active) ?? enabled[0])
                .position,
            );
          else highlight(enabled[enabled.length - 1].position);
        } else if (event.key === "ArrowLeft" || event.key === "Escape") {
          // Only this level closes; the menu under it stays open.
          event.preventDefault();
          event.stopPropagation();
          onBack();
        } else if (
          event.key === "Enter" ||
          (event.key === " " && !typeahead.typing())
        ) {
          event.preventDefault();
          pick(items[active]);
        } else if (event.key === "ArrowRight") {
          const settings = items[active]?.settings;
          if (settings && !items[active].disabled) {
            event.preventDefault();
            onDone();
            settings.onSelect();
          }
        } else if (printable(event) && searchable !== undefined) {
          // Typing from a row goes on in the search field.
          if (event.target !== search.current) search.current?.focus();
        } else if (printable(event)) {
          // A hint is a key that picks its row: the digits of Move to group.
          const hit = typeahead.typing()
            ? undefined
            : items.find(
                (item) => item.hint?.toLowerCase() === event.key.toLowerCase(),
              );
          if (hit) {
            event.preventDefault();
            pick(hit);
            return;
          }
          const found = typeaheadPosition(
            enabled.map(({ item, position }) =>
              shownLabel(
                ref.current,
                `[data-position="${position}"]`,
                item.label,
              ),
            ),
            current,
            typeahead.type(event.key),
          );
          if (found >= 0) {
            event.preventDefault();
            highlight(enabled[found].position);
          }
        }
      }}
    >
      {header}
      {searchable !== undefined && (
        <label className="menu-search">
          <input
            ref={search}
            value={query}
            placeholder={searchable}
            aria-label={searchable}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {searchable !== undefined && needle && items.length === 0 && (
        <p className="menu-search-empty">{searchEmpty}</p>
      )}
      {entries.map((entry, index) => {
        if (!isItem(entry)) return <Decoration key={index} entry={entry} />;
        const position = ++row;
        return (
          <ReasonTooltip key={index} reason={entry.title}>
            {(tip) => (
              <button
                data-position={position}
                role={itemRole(entry.checked, entry.checkedRole ?? "radio")}
                aria-checked={entry.checked}
                aria-describedby={tip?.["aria-describedby"]}
                disabled={entry.disabled}
                tabIndex={active === position ? 0 : -1}
                className={`${active === position ? "active" : ""}${entry.description ? " has-description" : ""}`}
                onPointerEnter={(event) => {
                  tip?.onPointerEnter(event);
                  // A disabled row is never lit.
                  if (entry.disabled) return;
                  highlight(position, true);
                }}
                onPointerLeave={(event) => {
                  tip?.onPointerLeave();
                  const next = event.relatedTarget;
                  const toRow =
                    next instanceof Element &&
                    ref.current?.contains(next) &&
                    next.closest("[data-position]:not(:disabled)");
                  // Off the row onto padding, a rule or outside: nothing
                  // stays lit, and the submenu takes focus back.
                  if (!toRow && position === active) {
                    setActive(-1);
                    if (document.activeElement?.closest('[role="menu"]'))
                      ref.current?.focus({ preventScroll: true });
                  }
                }}
                onFocus={(event) => {
                  setActive(position);
                  tip?.onFocus(event);
                }}
                onBlur={tip?.onBlur}
                onPointerDown={tip?.onPointerDown}
                onClick={() => pick(entry)}
              >
                {entry.description ? (
                  <span className="menu-item-text">
                    <span data-no-translate={entry.noTranslate || undefined}>
                      {entry.label}
                      {entry.badgeInline && entry.badge && (
                        <span className="rate-badge">{entry.badge}</span>
                      )}
                    </span>
                    <small
                      className={`menu-description${entry.descriptionWraps ? " wraps" : ""}`}
                    >
                      {entry.description}
                    </small>
                  </span>
                ) : (
                  <span data-no-translate={entry.noTranslate || undefined}>
                    {entry.label}
                    {entry.badgeInline && entry.badge && (
                      <span className="rate-badge">{entry.badge}</span>
                    )}
                  </span>
                )}
                {entry.badge && !entry.badgeInline && (
                  <span className="rate-badge">{entry.badge}</span>
                )}
                {entry.value && (
                  <MenuValue value={entry.value} label={entry.valueLabel} />
                )}
                {entry.hint && showsShortcuts && <kbd>{entry.hint}</kbd>}
                <RowShortcut keys={entry.shortcut} />
                {entry.checked && <Check size={16} className="menu-check" />}
                <RowGear item={entry} onDone={onDone} />
              </button>
            )}
          </ReasonTooltip>
        );
      })}
      {searchCreate?.empty && !needle && nothingListed && (
        <p className="menu-search-empty">{searchCreate.empty}</p>
      )}
    </div>
  );
}
