import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { ChevronRight, Plus } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";

/**
 * Connectors → Add connector › in the add menu: with the right to add a custom
 * connector it opens a submenu of Browse connectors (Library) and Add custom
 * connector (DotsHorizontal); without it the row is Browse connectors alone,
 * with no chevron.
 *
 * Like Tool access, the choices open beside the connectors list as a fixed
 * panel next to this row; in a phone sheet they open in place.
 */
export function ConnectorAddMenu({
  sheet,
  canAddCustom,
  hasConnectors = true,
  onBrowse,
  onAddCustom,
}: {
  /** The add menu is a phone sheet: the choices open in place. */
  sheet: boolean;
  canAddCustom: boolean;
  /** With none yet the entry adds them. */
  hasConnectors?: boolean;
  onBrowse: () => void;
  onAddCustom: () => void;
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
  if (!canAddCustom)
    return (
      <button role="menuitem" onClick={onBrowse}>
        <AppIcon name={hasConnectors ? "Library" : "Plus"} size={20} />
        <span>{hasConnectors ? "Browse connectors" : "Add connectors"}</span>
      </button>
    );
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
  const items = (
    <>
      <button role="menuitem" onClick={onBrowse}>
        <AppIcon name="Library" size={20} />
        <span>Browse connectors</span>
      </button>
      <button role="menuitem" onClick={onAddCustom}>
        <AppIcon name="DotsHorizontal" size={20} />
        <span>Add custom connector</span>
      </button>
    </>
  );
  return (
    <div
      className="composer-add-branch composer-add-nested"
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
        <Plus />
        <span>{hasConnectors ? "Add connector" : "Add connectors"}</span>
        <ChevronRight className="composer-add-chevron" />
      </button>
      {open && (
        <div
          ref={panel}
          className={
            sheet
              ? "composer-add-nested-inline"
              : "composer-add-submenu composer-add-nested-panel"
          }
          role="menu"
          aria-label={t("Add connector")}
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
