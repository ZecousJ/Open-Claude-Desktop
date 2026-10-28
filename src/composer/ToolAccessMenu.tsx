import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ToolSearchMode } from "../../shared/tool-search-mode";
import { t } from "../i18n";
import { Check, ChevronRight, Search } from "../ui/glyphs";

/**
 * Connectors → Tool access in the add menu: this conversation's choice between
 * loading connector tools when needed and having them all loaded, each with the
 * note Settings → Capabilities shows for it. The choice applies from the next
 * message (shared/tool-search-mode.ts).
 *
 * The connectors list scrolls, so the choices open beside it as a fixed panel
 * next to this row; in a phone sheet they open in place.
 */
const choices: { mode: ToolSearchMode; label: string; note: string }[] = [
  {
    mode: "on",
    label: "Load tools when needed",
    note: "Chats compact less since tools aren’t pre-loaded.",
  },
  {
    mode: "off",
    label: "Tools already loaded",
    note: "Chats compact more often since tools are always there.",
  },
];

export function ToolAccessMenu({
  mode,
  onChoose,
  disabledReason,
  sheet,
}: {
  mode: ToolSearchMode;
  onChoose: (mode: ToolSearchMode) => void;
  /** Why the choice can't change now (a message is being processed). */
  disabledReason?: string;
  /** The add menu is a phone sheet: the choices open in place. */
  sheet: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number }>();
  useLayoutEffect(() => {
    if (!open || sheet || !trigger.current) return;
    const row = trigger.current.getBoundingClientRect();
    const menu = trigger.current.closest(".composer-add-submenu");
    const edge = menu?.getBoundingClientRect() ?? row;
    const width = panel.current?.offsetWidth ?? 0;
    // Beside the connectors list, on the side the add menu opens to.
    const right = edge.right + 5;
    const left =
      right + width > window.innerWidth ? edge.left - 5 - width : right;
    setPlace({ top: row.top - 4, left: Math.max(8, left) });
  }, [open, sheet]);
  const show = (focus: boolean) => {
    setOpen(true);
    if (focus)
      requestAnimationFrame(() =>
        panel.current?.querySelector<HTMLButtonElement>("button")?.focus(),
      );
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const items = choices.map((choice) => (
    <button
      key={choice.mode}
      role="menuitemcheckbox"
      aria-checked={mode === choice.mode}
      className="composer-add-choice"
      disabled={disabledReason !== undefined}
      title={disabledReason}
      onClick={() => {
        if (mode !== choice.mode) onChoose(choice.mode);
        close();
      }}
    >
      <span className="composer-add-choice-text">
        <span>{t(choice.label)}</span>
        <small>{t(choice.note)}</small>
      </span>
      {mode === choice.mode && <Check aria-hidden="true" />}
    </button>
  ));
  return (
    <div
      className="composer-add-branch composer-add-tool-access"
      onMouseEnter={() => !sheet && show(false)}
      onMouseLeave={() => !sheet && setOpen(false)}
    >
      <button
        ref={trigger}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            show(true);
          }
        }}
      >
        <Search />
        <span>{t("Tool access")}</span>
        <ChevronRight className="composer-add-chevron" />
      </button>
      {open && (
        <div
          ref={panel}
          className={
            sheet
              ? "composer-add-tool-access-inline"
              : "composer-add-submenu composer-add-tool-access-panel"
          }
          role="menu"
          aria-label={t("Tool access")}
          style={
            sheet
              ? undefined
              : place
                ? { top: place.top, left: place.left }
                : { visibility: "hidden" }
          }
          onKeyDown={keys}
        >
          {items}
        </div>
      )}
    </div>
  );
}
