import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "./glyphs";
import { t } from "../i18n";
import { useDismiss } from "./useDismiss";
import { useExitPresence } from "./usePresence";
import { ReasonTooltip, showsShortcuts } from "./Tooltip";
import {
  SUBMENU_OPEN_DELAY_MS,
  headingForSubmenu,
  itemRole,
  stepPosition,
  typeaheadPosition,
} from "./menu-keys";
import { Submenu } from "./Submenu";
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

export type MenuEntry =
  | { separator: true }
  /** A grey group label, e.g. "Recent". */
  | { heading: string }
  | {
      label: string;
      /** Grey text before the chevron, e.g. the current choice. */
      value?: string;
      valueLabel?: string;
      /**
       * A muted line under the label saying what the item does, e.g. Rewind
       * to here's "Removes this message and what follows" (the original's
       * menu item description, one line, cut with an ellipsis).
       */
      description?: string;
      /**
       * The description wraps to as many lines as it needs instead of one cut
       * line.
       */
      descriptionWraps?: boolean;
      /** Tooltip, e.g. the full path behind a folder name. */
      title?: string;
      /** A name (a folder's, a file's), never put through the interface translation. */
      noTranslate?: boolean;
      /** Single-key shortcut shown on the right; pressing it selects the item. */
      hint?: string;
      /**
       * A key combination shown on the right as the platform writes it
       * (["mod", "C"]: "⌘ C" on macOS, "Ctrl+C" elsewhere). Display only:
       * whoever owns the menu handles the keys.
       */
      shortcut?: string[];
      danger?: boolean;
      /** Shown greyed out and skipped by keys and clicks. */
      disabled?: boolean;
      /**
       * A tooltip at the row's end while it is highlighted (the original's
       * menu item tooltips: a permission mode's description).
       */
      tooltip?: string;
      checked?: boolean;
      checkedRole?: "checkbox" | "radio";
      /**
       * Choosing the row (a check that toggles) leaves the menu open, as the
       * original's keepOpen items, at the root or in a submenu.
       */
      keepOpen?: boolean;
      /**
       * A switch at the row's end, on or off (the original's menu item with
       * a trailing xs Switch and role menuitemcheckbox: Keep computer awake).
       */
      switched?: boolean;
      submenu?: MenuEntry[];
      /**
       * A submenu that opens with a search field (placeholder given): typing
       * narrows its rows by label, as the original's "Add to project" list.
       */
      searchable?: string;
      /**
       * What a searchable submenu says when nothing matches the typed text,
       * instead of "No matches".
       */
      searchEmpty?: string;
      /**
       * A searchable submenu's create row: `idle` heads the list over a rule
       * while nothing is typed ("New project"); once something is, `typed` with
       * {name} ends the list ("Create project {name}") instead of "No matches".
       * `empty` is what an empty list says ("No projects yet").
       */
      searchCreate?: {
        idle: string;
        typed: string;
        empty?: string;
        onSelect: (name: string) => void;
      };
      /** A greyed row that the original draws with a chevron (a submenu Claudex has no content for). */
      chevron?: boolean;
      /**
       * A settings gear at the row's right edge while it is hovered or
       * highlighted; → on the row does the same. Greyed with the row when it is
       * disabled.
       */
      settings?: { label: string; onSelect: () => void };
      /**
       * A small button at the row's end that does something other than choosing
       * the row, and leaves the menu open; → does the same, `hint` says so to
       * screen readers.
       */
      /**
       * Actions a right-click on the row opens at the pointer. Choosing one
       * closes both menus.
       */
      contextMenu?: MenuEntry[];
      trailing?: {
        text: string;
        label: string;
        danger?: boolean;
        hint?: string;
        onAction: () => void;
      };
      /** A 20px glyph before the label; the web's menus draw them. */
      icon?: ReactNode;
      /** A small badge after the label, e.g. a group's rate "0.25x" (the page styles `.rate-badge`). */
      badge?: string;
      /** CDS template badges participate in the label’s inline line box. */
      badgeInline?: boolean;
      onSelect?: () => void;
    };
export type Item = Extract<MenuEntry, { label: string }>;

/**
 * Where the menu's frame sits, in window coordinates as for CSS `fixed`;
 * `bottom` (distance from the window's bottom edge) opens it upwards.
 */
export type MenuPosition = {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
};

/** A row's trailing button; a click does not choose the row. */
function RowTrailing({ item }: { item: Item }) {
  if (!item.trailing) return null;
  const { text, label, danger, onAction } = item.trailing;
  return (
    <span
      role="button"
      aria-label={label}
      aria-disabled={item.disabled || undefined}
      className={`menu-trailing-button${danger ? " is-danger" : ""}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (!item.disabled) onAction();
      }}
    >
      {text}
    </span>
  );
}

/**
 * Row heights (published for the other packages, which pick one and do not
 * change the component): "compact" 24px rows; "regular" 32px rows with 14px
 * text and a 24px heading.
 */
export type MenuSize = "compact" | "regular";

/**
 * How the last input arrived. A menu opened from the keyboard lights its first
 * row (its last for ↑) at once, as the original's does; one opened with the
 * pointer lights nothing until the pointer reaches a row.
 */
let lastInput = { keyboard: false, key: "" };
if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (event) => {
      lastInput = { keyboard: true, key: event.key };
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInput = { keyboard: false, key: "" };
    },
    true,
  );
}

/** How long a web menu stays to slide away: it is a sheet on a touch phone. */
export function menuSheetExitMs() {
  if (typeof document === "undefined") return 0;
  if (document.documentElement.dataset.surface !== "web") return 0;
  return globalThis.matchMedia?.("(pointer: coarse) and (max-width: 639.98px)")
    .matches
    ? 300
    : 0;
}

/**
 * Floating menu with keyboard navigation, single-key hints and submenus that
 * open 2px to the right, level with their row. Rendered in a portal so sidebar
 * clipping does not cut it off.
 *
 * Keys follow the original's menus: focus moves through the rows and loops at
 * the ends, Home/End jump to them, typed letters move to the row they start,
 * Escape or ← in a submenu closes only that submenu, and closing the menu gives
 * focus back to the element that had it (its trigger). A submenu opens 100ms
 * after its row is hovered, and a pointer moving diagonally towards an open
 * submenu does not switch rows on its way. The menu opens and closes without
 * motion, as the original's popup; as a sheet on a touch phone (menu.css) it
 * slides down and its scrim fades for 0.3s as it closes.
 */
export function Menu({
  label,
  entries: allEntries,
  searchable,
  searchEntries,
  bodyClassName,
  position,
  width,
  size = "compact",
  maxVisibleItems,
  showRootHints = showsShortcuts,
  anchors = [],
  autoFocus = true,
  className,
  submenuClassName,
  frameRef,
  container,
  onClose,
}: {
  label: string;
  entries: MenuEntry[];
  searchable?: string;
  /** Search leaf records behind a grouped root, such as cloud environments. */
  searchEntries?: (query: string) => MenuEntry[];
  /** An opt-in body wrapper for a popup with a separately measured search header. */
  bodyClassName?: string;
  position: MenuPosition;
  width: number | "max-content";
  size?: MenuSize;
  /**
   * How many rows show before the list scrolls (the original's
   * `maxVisibleItems`: rows times the row height plus the menu's padding).
   */
  maxVisibleItems?: number;
  /** A captured root's single-key hints; other menus and submenus keep their surface default. */
  showRootHints?: boolean;
  /** A class for the menu's frame (a menu that draws its rows' icons). */
  className?: string;
  /** An opt-in frame class for child popups; other roots keep independent frames. */
  submenuClassName?: string;
  /** Elements whose clicks should not dismiss the menu (its trigger). */
  anchors?: RefObject<HTMLElement | null>[];
  autoFocus?: boolean;
  /** Receives the menu's frame (a parent menu keeps a click in it from closing itself). */
  frameRef?: RefObject<HTMLDivElement | null>;
  container?: Element;
  onClose: () => void;
}) {
  const [needle, setNeedle] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const entries =
    searchable && needle
      ? (searchEntries?.(needle) ??
        allEntries.filter(
          (entry) =>
            isItem(entry) &&
            (entry.noTranslate ? entry.label : t(entry.label))
              .toLocaleLowerCase()
              .includes(needle.toLocaleLowerCase()),
        ))
      : allEntries;
  const box = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const [sheetExitMs] = useState(menuSheetExitMs);
  useExitPresence(box, sheetExitMs);
  useExitPresence(scrim, sheetExitMs);
  const contextBox = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{
    index: number;
    x: number;
    y: number;
  }>();
  useEffect(() => {
    if (!frameRef) return;
    frameRef.current = box.current;
    return () => {
      frameRef.current = null;
    };
  });
  const sub = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState<{
    index: number;
    top: number;
    /** Opened from the keyboard: focus moves into it. */
    focus: boolean;
    /** Opened by the pointer resting on its row, so leaving it closes it. */
    hover: boolean;
  }>();
  const [place, setPlace] = useState(position);
  // The element focused before the menu took focus, usually its trigger.
  const [opener] = useState(() =>
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const switchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Where the pointer left an open submenu's row, the apex of its safe triangle.
  const apex = useRef<{ x: number; y: number }>(undefined);
  const typeahead = useTypeahead();
  // Modal as the original's: a press outside only closes the menu.
  useDismiss([box, sub, contextBox, ...anchors], true, onClose, {
    modal: true,
  });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    if (position.bottom !== undefined) {
      if (rect.top < 8) setPlace({ ...position, bottom: undefined, top: 8 });
      return;
    }
    const top = Math.min(
      position.top ?? 0,
      window.innerHeight - rect.height - 8,
    );
    const left =
      position.left !== undefined
        ? Math.max(
            8,
            Math.min(position.left, window.innerWidth - rect.width - 8),
          )
        : position.left;
    setPlace({ ...position, left, top: Math.max(8, top) });
  }, [position.left, position.right, position.top, position.bottom, width]);
  // Closing hands focus back, unless the person already moved it elsewhere.
  useLayoutEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(switchTimer.current);
      const focused = document.activeElement;
      const inside =
        !focused ||
        focused === document.body ||
        box.current?.contains(focused) ||
        sub.current?.contains(focused);
      if (inside && opener?.isConnected && opener !== document.body)
        opener.focus({ preventScroll: true });
    },
    [],
  );

  const items = entries.map((entry, index) => ({ entry, index }));
  const selectable = items.filter(
    ({ entry }) => isItem(entry) && !entry.disabled,
  );
  const highlight = (index: number, fromPointer = false) => {
    setActive(index);
    focusRow(box.current, `[data-index="${index}"]`, fromPointer);
  };
  useEffect(() => {
    if (!autoFocus) return;
    if (searchable) {
      search.current?.focus({ preventScroll: true });
      return;
    }
    box.current?.focus({ preventScroll: true });
    if (lastInput.keyboard && selectable.length)
      highlight(
        selectable[lastInput.key === "ArrowUp" ? selectable.length - 1 : 0]
          .index,
      );
  }, []);
  const openSubmenu = (index: number, focus: boolean, hover = false) => {
    clearTimeout(openTimer.current);
    const row = box.current?.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    );
    // The submenu's top border lines up with the row.
    if (row)
      setOpen({ index, top: row.getBoundingClientRect().top, focus, hover });
  };
  const closeSubmenu = () => {
    clearTimeout(openTimer.current);
    apex.current = undefined;
    setOpen(undefined);
  };
  const choose = (item: Item, index: number, focus = false) => {
    if (item.disabled) return;
    // A click on a row with a search field puts the cursor in it.
    if (item.submenu)
      return openSubmenu(index, focus || Boolean(item.searchable));
    if (!item.keepOpen) onClose();
    item.onSelect?.();
  };
  // The pointer settled on a row: highlight it, and open its submenu after
  // the hover delay.
  const settle = (index: number) => {
    clearTimeout(switchTimer.current);
    switchTimer.current = undefined;
    apex.current = undefined;
    const entry = entries[index];
    highlight(index, true);
    if (open?.index === index) return;
    closeSubmenu();
    if (entry && isItem(entry) && entry.submenu)
      openTimer.current = setTimeout(
        () => openSubmenu(index, false, true),
        SUBMENU_OPEN_DELAY_MS,
      );
  };
  // A submenu the pointer opened closes when the pointer leaves it for anywhere
  // but its own row, and when it leaves the menu for anywhere but the submenu
  // or the way to it.
  const leaveMenus = (event: PointerEvent, fromSubmenu: boolean) => {
    if (!open?.hover || event.pointerType === "touch") return;
    const to = event.relatedTarget;
    if (to instanceof Node) {
      const row = box.current?.querySelector(`[data-index="${open.index}"]`);
      if (row?.contains(to) || (!fromSubmenu && sub.current?.contains(to)))
        return;
    }
    const submenuBox = sub.current?.getBoundingClientRect();
    if (
      !fromSubmenu &&
      apex.current &&
      submenuBox &&
      headingForSubmenu(
        { x: event.clientX, y: event.clientY },
        apex.current,
        submenuBox,
      )
    )
      return;
    closeSubmenu();
  };
  // The pointer is over something that is not a row: nothing stays lit
  // (Base UI resets the highlight on pointer leave) and the menu itself
  // takes focus back, unless focus is outside any menu.
  const unlight = () => {
    clearTimeout(openTimer.current);
    setActive(-1);
    if (document.activeElement?.closest('[role="menu"]'))
      box.current?.focus({ preventScroll: true });
  };
  const hover = (index: number, event: PointerEvent) => {
    const row = entries[index];
    if (row && isItem(row) && row.disabled) {
      // A disabled row is never lit.
      if (active >= 0 && open?.index === undefined) unlight();
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const submenuBox = sub.current?.getBoundingClientRect();
    if (
      open &&
      open.index !== index &&
      apex.current &&
      submenuBox &&
      headingForSubmenu(point, apex.current, submenuBox)
    ) {
      // On its way to the submenu: switch only if it stops here.
      clearTimeout(switchTimer.current);
      switchTimer.current = setTimeout(
        () => settle(index),
        SUBMENU_OPEN_DELAY_MS,
      );
      return;
    }
    if (index !== active || switchTimer.current !== undefined) settle(index);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      event.target === search.current &&
      !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)
    )
      return;
    // Tab leaves the menu: it closes, and focus goes back to its trigger.
    if (event.key === "Tab") {
      event.preventDefault();
      onClose();
      return;
    }
    // A held Enter or Space acts once.
    if (
      event.repeat &&
      (event.key === "Enter" || (event.key === " " && !typeahead.typing()))
    ) {
      event.preventDefault();
      return;
    }
    const current = selectable.findIndex(({ index }) => index === active);
    const step = stepPosition(event.key, current, selectable.length);
    if (step !== undefined) {
      event.preventDefault();
      highlight(selectable[step].index);
      closeSubmenu();
      return;
    }
    const space = event.key === " " && !typeahead.typing();
    if (event.key === "ArrowRight" || event.key === "Enter" || space) {
      const entry = entries[active];
      if (entry && isItem(entry)) {
        event.preventDefault();
        if (
          event.key === "ArrowRight" &&
          entry.trailing &&
          !entry.disabled &&
          !entry.submenu
        ) {
          entry.trailing.onAction();
        } else if (
          event.key === "ArrowRight" &&
          entry.settings &&
          !entry.disabled &&
          !entry.submenu
        ) {
          onClose();
          entry.settings.onSelect();
        } else if (event.key !== "ArrowRight" || entry.submenu)
          choose(entry, active, true);
      }
      return;
    }
    if (!printable(event)) return;
    const hit = typeahead.typing()
      ? undefined
      : items.find(
          ({ entry }) =>
            isItem(entry) &&
            entry.hint?.toLowerCase() === event.key.toLowerCase(),
        );
    if (hit && isItem(hit.entry)) {
      event.preventDefault();
      choose(hit.entry, hit.index, true);
      return;
    }
    const labels = selectable.map(({ entry, index }) =>
      shownLabel(box.current, `[data-index="${index}"]`, (entry as Item).label),
    );
    const found = typeaheadPosition(labels, current, typeahead.type(event.key));
    if (found >= 0) {
      event.preventDefault();
      highlight(selectable[found].index);
      closeSubmenu();
    }
  };
  const submenu = open && entries[open.index];
  const rect = box.current?.getBoundingClientRect();
  const wrapBody = (children: ReactNode) =>
    bodyClassName ? <div className={bodyClassName}>{children}</div> : children;

  return createPortal(
    <>
      {/* The dimmed page behind the menu when it is a sheet on a touch
          phone (menu.css); hidden otherwise. A press on it is outside the
          menu, so it only closes it. */}
      <div ref={scrim} className="menu-sheet-scrim" aria-hidden="true" />
      <div
        ref={box}
        className={`menu u-scroll-fade-y ${size}${className ? ` ${className}` : ""}`}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{
          ...place,
          width,
          maxHeight:
            maxVisibleItems === undefined
              ? undefined
              : `min(${maxVisibleItems * (size === "regular" ? 32 : 24) + 10}px, var(--available-height, calc(100vh - 16px)))`,
        }}
        onKeyDown={keyDown}
        onPointerLeave={(event) => leaveMenus(event, false)}
      >
        {searchable && (
          <label className="menu-search">
            <input
              ref={search}
              placeholder={t(searchable)}
              aria-label={t(searchable)}
              value={needle}
              onChange={(event) => {
                setNeedle(event.target.value);
                setActive(-1);
                setOpen(undefined);
              }}
            />
          </label>
        )}
        {wrapBody(
          <>
            {searchable && needle && !entries.length && (
              <p className="menu-search-empty">{t("No environments")}</p>
            )}
            {entries.map((entry, index) =>
              isItem(entry) ? (
                <ReasonTooltip
                  key={index}
                  reason={
                    entry.disabled
                      ? entry.title
                      : (entry.tooltip ?? entry.title)
                  }
                >
                  {(tip) => (
                    <button
                      data-index={index}
                      role={itemRole(
                        entry.checked ?? entry.switched,
                        entry.checkedRole ?? "checkbox",
                      )}
                      aria-checked={entry.checked ?? entry.switched}
                      aria-describedby={tip?.["aria-describedby"]}
                      aria-description={entry.trailing?.hint}
                      onContextMenu={
                        entry.contextMenu?.length
                          ? (event) => {
                              event.preventDefault();
                              setContext({
                                index,
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }
                          : undefined
                      }
                      disabled={entry.disabled}
                      tabIndex={active === index ? 0 : -1}
                      aria-haspopup={entry.submenu ? "menu" : undefined}
                      aria-expanded={
                        entry.submenu ? open?.index === index : undefined
                      }
                      className={`${active === index ? "active" : ""} ${entry.danger ? "danger" : ""}${entry.description ? " has-description" : ""}`}
                      onPointerEnter={(event) => {
                        tip?.onPointerEnter(event);
                        hover(index, event);
                      }}
                      onPointerMove={(event) => hover(index, event)}
                      onPointerLeave={(event) => {
                        tip?.onPointerLeave();
                        if (open?.index === index)
                          apex.current = { x: event.clientX, y: event.clientY };
                        else if (index === active)
                          clearTimeout(openTimer.current);
                        const next = event.relatedTarget;
                        const toRow =
                          next instanceof Element &&
                          box.current?.contains(next) &&
                          next.closest("[data-index]:not(:disabled)");
                        // Off the row onto padding, a rule or outside the menu:
                        // its own highlight goes (not one a key moved elsewhere,
                        // and not a row whose submenu is open).
                        if (!toRow && index === active && open?.index !== index)
                          unlight();
                      }}
                      onFocus={(event) => {
                        setActive(index);
                        tip?.onFocus(event);
                      }}
                      onBlur={tip?.onBlur}
                      onPointerDown={tip?.onPointerDown}
                      onClick={() => choose(entry, index)}
                    >
                      {entry.icon && <i className="menu-icon">{entry.icon}</i>}
                      {entry.description ? (
                        <span className="menu-item-text">
                          <span
                            data-no-translate={entry.noTranslate || undefined}
                          >
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
                        <span
                          data-no-translate={entry.noTranslate || undefined}
                        >
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
                        <MenuValue
                          value={entry.value}
                          label={entry.valueLabel}
                        />
                      )}
                      {entry.hint && showRootHints && <kbd>{entry.hint}</kbd>}
                      <RowShortcut keys={entry.shortcut} />
                      {entry.checked && (
                        <Check size={16} className="menu-check" />
                      )}
                      {entry.switched !== undefined && (
                        <span
                          className="menu-switch"
                          data-checked={entry.switched || undefined}
                          aria-hidden="true"
                        >
                          <span />
                        </span>
                      )}
                      <RowGear item={entry} onDone={onClose} />
                      <RowTrailing item={entry} />
                      {(entry.submenu || entry.chevron) && (
                        <ChevronRight size={16} />
                      )}
                    </button>
                  )}
                </ReasonTooltip>
              ) : (
                <Decoration key={index} entry={entry} />
              ),
            )}
          </>,
        )}
      </div>
      {submenu && isItem(submenu) && submenu.submenu && rect && (
        <Submenu
          ref={sub}
          size={size}
          className={submenuClassName}
          label={submenu.label}
          entries={submenu.submenu}
          searchable={submenu.searchable}
          searchEmpty={submenu.searchEmpty ? t(submenu.searchEmpty) : undefined}
          searchCreate={submenu.searchCreate}
          left={rect.right + 2}
          top={open.top}
          flipRight={rect.left - 2}
          focusOnOpen={open.focus}
          onArrive={() => {
            clearTimeout(switchTimer.current);
            switchTimer.current = undefined;
            apex.current = undefined;
          }}
          onLeave={(event) => leaveMenus(event, true)}
          onBack={() => {
            const index = open.index;
            closeSubmenu();
            highlight(index);
          }}
          onDone={onClose}
        />
      )}
      {context &&
        (() => {
          const owner = entries[context.index];
          if (!owner || !isItem(owner) || !owner.contextMenu) return null;
          const close = () => setContext(undefined);
          return (
            <Menu
              label={owner.label}
              entries={owner.contextMenu.map((entry) =>
                isItem(entry) && entry.onSelect
                  ? {
                      ...entry,
                      onSelect: () => {
                        onClose();
                        entry.onSelect?.();
                      },
                    }
                  : entry,
              )}
              position={{ left: context.x + 2, top: context.y + 2 }}
              width={200}
              frameRef={contextBox}
              onClose={close}
            />
          );
        })()}
    </>,
    container ?? document.body,
  );
}
