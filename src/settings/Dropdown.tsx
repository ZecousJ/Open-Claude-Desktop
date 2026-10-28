import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "../ui/glyphs";
import { ChevronDownIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import { ReasonTooltip } from "../ui/Tooltip";
import { dropdownPlacement, nextChoice } from "./controls";
import type { Choice, ListPlace } from "./controls";

/**
 * A setting's choice list. `Dropdown` is the borderless value-and-chevron
 * trigger of General and Account; `bordered` gives the framed field of System's
 * shortcuts. The list opens 6px below with its right edge on the trigger's
 * (above when it does not fit), starts on the current choice, and follows the
 * arrow keys, Home/End, a typed letter, Enter/Space and Escape.
 */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  bordered = false,
  width,
  trailing,
  onOpenChange,
  menuWidth,
  highlightSelectedOnOpen = false,
}: {
  label: string;
  value: T | undefined;
  options: Choice<T>[];
  onChange: (value: T) => void;
  /** Shown dimmed while nothing is chosen (Account → work type). */
  placeholder?: string;
  disabled?: boolean;
  /** The framed field (SelectField) instead of the borderless trigger. */
  bordered?: boolean;
  /** The framed field's width; 219 by default. */
  width?: number;
  /**
   * Draws the end of an option in place of the check (Voice → Style's
   * preview cell); `active` is the highlighted row.
   */
  trailing?: (
    option: Choice<T>,
    state: { selected: boolean; active: boolean },
  ) => ReactNode;
  /** Told when the list opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** The list's fixed width (22rem for Tool access mode); at least 192 otherwise. */
  menuWidth?: number;
  /** Current select-mode Comboboxes highlight their selected item on pointer open too. */
  highlightSelectedOnOpen?: boolean;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<ListPlace>();
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.findIndex((option) => option.value === value);
  const current = options[selected];
  const close = (focusTrigger = false) => {
    setOpen(false);
    setPlace(undefined);
    if (focusTrigger) anchor.current?.focus();
  };
  useDismiss([anchor, list], open, () => close(true));

  // Measure the list, then place it against the trigger.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !list.current) return;
    setPlace(
      dropdownPlacement(
        anchor.current.getBoundingClientRect(),
        list.current.getBoundingClientRect().height,
        { width: innerWidth, height: innerHeight },
      ),
    );
    list.current.focus();
  }, [open]);
  // A list left floating over a page that moved would point at nothing.
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !list.current?.contains(target)) close();
    };
    addEventListener("scroll", away, true);
    addEventListener("resize", away);
    return () => {
      removeEventListener("scroll", away, true);
      removeEventListener("resize", away);
    };
  }, [open]);

  // A click opens the list with no row lit until the pointer moves over one;
  // the keyboard opens it on the current choice.
  const show = (byKeyboard = true) => {
    if (disabled) return;
    setActive(
      byKeyboard || highlightSelectedOnOpen
        ? selected >= 0
          ? selected
          : 0
        : -1,
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (option?.unavailable) return;
    close(true);
    if (option && option.value !== value) onChange(option.value);
  };
  const triggerKey = (event: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      show();
    }
  };
  const listKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // A held key picks once.
      if (active >= 0 && !event.repeat) choose(active);
      return;
    }
    // Back on the trigger, so Tab moves on from there instead of leaving Settings.
    if (event.key === "Tab") return close(true);
    const next = nextChoice(
      options.map((option) => option.label),
      active,
      event.key,
    );
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`${bordered ? "settings-select" : "settings-dropdown"} ${open ? "open" : ""}`}
        style={bordered && width ? { width } : undefined}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={(event) => (open ? close() : show(event.detail === 0))}
        onKeyDown={triggerKey}
      >
        {current || !placeholder ? (
          <span style={current?.style}>{current?.label ?? value}</span>
        ) : (
          <span className="settings-placeholder">{placeholder}</span>
        )}
        <ChevronDownIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            className="settings-dropdown-menu"
            role="listbox"
            aria-label={label}
            aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
            tabIndex={-1}
            // Transparent until measured and placed (still focusable, unlike visibility: hidden).
            style={{
              ...(place ?? {
                right: 0,
                top: 0,
                opacity: 0,
                pointerEvents: "none",
              }),
              ...(menuWidth ? { width: menuWidth } : {}),
            }}
            onKeyDown={listKey}
          >
            {options.map((option, index) => (
              <ReasonTooltip key={option.value} reason={option.unavailable}>
                {(tip) => (
                  <div
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.unavailable ? true : undefined}
                    aria-describedby={tip?.["aria-describedby"]}
                    className={`${index === active ? "active" : ""} ${option.unavailable ? "unavailable" : ""} ${option.description ? "has-description" : ""}`}
                    onPointerEnter={tip?.onPointerEnter}
                    onPointerLeave={tip?.onPointerLeave}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(index)}
                  >
                    {option.description ? (
                      <span className="settings-option-text">
                        <span className="settings-option-title">
                          <span style={option.style}>{option.label}</span>
                          {option.badge && (
                            <span className="settings-option-badge">
                              {option.badge}
                            </span>
                          )}
                        </span>
                        <span className="settings-option-description">
                          {option.description}
                        </span>
                      </span>
                    ) : (
                      <span style={option.style}>{option.label}</span>
                    )}
                    {trailing
                      ? trailing(option, {
                          selected: option.value === value,
                          active: index === active,
                        })
                      : option.value === value && (
                          <Check size={18} strokeWidth={1.5} />
                        )}
                  </div>
                )}
              </ReasonTooltip>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
