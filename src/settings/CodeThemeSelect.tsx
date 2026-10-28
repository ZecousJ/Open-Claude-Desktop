import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "../ui/app-icon";
import { useDismiss } from "../ui/useDismiss";
import { useT } from "../i18n";
import { isEditEndKey } from "../ui/ime";
import { dropdownPlacement } from "./controls";
import "./code-theme-select.css";

/**
 * Source c71860c77:2292 select-mode combobox; current popup has a search
 * combobox and 32px options inside a 12px-radius dialog. Only genuinely
 * supported, persisted renderer palettes are supplied.
 */
export function CodeThemeSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const t = useT(),
    id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>();
  const field = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const filtered = options.filter((o) =>
    t(o.label).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const shown = options.find((o) => o.value === value)?.label ?? value;
  const close = (focus = true) => {
    setOpen(false);
    setQuery("");
    setPlace(undefined);
    if (focus) trigger.current?.focus();
  };
  useDismiss([field, popup], open, () => close());
  useLayoutEffect(() => {
    if (!open || !field.current || !popup.current) return;
    const box = field.current.getBoundingClientRect();
    const { right: _right, ...vertical } = dropdownPlacement(
      box,
      popup.current.getBoundingClientRect().height,
      { width: innerWidth, height: innerHeight },
    );
    const width = Math.min(Math.max(192, box.width), innerWidth - 16);
    setPlace({
      ...vertical,
      width,
      left: Math.max(8, Math.min(box.left, innerWidth - width - 8)),
    });
  }, [open, filtered.length]);
  useLayoutEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !popup.current?.contains(event.target)
      )
        close(false);
    };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);
  const show = () => {
    if (disabled) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = filtered[index];
    if (!option || disabled) return;
    close();
    if (option.value !== value) onChange(option.value);
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter" && isEditEndKey(event, "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) choose(active);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!filtered.length) return;
    setActive((current) =>
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? filtered.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) %
            filtered.length,
    );
  };
  return (
    <>
      <div
        ref={field}
        className={`settings-select code-theme-select${open ? " open" : ""}`}
        data-disabled={disabled || undefined}
      >
        <button
          ref={trigger}
          type="button"
          role="combobox"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={disabled}
          onClick={() => (open ? close() : show())}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
              event.preventDefault();
              show();
            }
          }}
        >
          <span>{t(shown)}</span>
          <AppIcon name="CaretDown" size={16} />
        </button>
      </div>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            aria-label={label}
            className="settings-dropdown-menu code-theme-dialog"
            style={place ?? { left: 0, top: 0, opacity: 0 }}
          >
            <input
              type="text"
              ref={search}
              role="combobox"
              aria-label={label}
              aria-expanded="true"
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={`${id}-list`}
              aria-activedescendant={
                filtered[active] ? `${id}-${active}` : undefined
              }
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={key}
            />
            <div
              role="listbox"
              id={`${id}-list`}
              aria-label={label}
              className="settings-dropdown-menu code-theme-options"
            >
              {filtered.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={index === active ? "active" : ""}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span>{t(option.label)}</span>
                  {option.value === value && <AppIcon name="Check" size={16} />}
                </div>
              ))}
              {!filtered.length && <p role="status">{t("No results")}</p>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
