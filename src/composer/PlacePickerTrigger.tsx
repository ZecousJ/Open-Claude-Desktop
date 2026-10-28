import { useRef, useState, type RefObject } from "react";
import { AppIcon } from "../ui/app-icon";
import { useDismiss } from "../ui/useDismiss";

export function PlacePickerTrigger({
  label,
  chosen,
  collapsed,
  native,
  badgeCount = 1,
  open,
  anchor,
  onToggle,
}: {
  label: string;
  chosen: boolean;
  collapsed: boolean;
  native?: boolean;
  badgeCount?: number;
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
}) {
  return (
    <div
      className="cowork-options"
      data-variant="chat"
      data-collapsed={collapsed || undefined}
      data-picker-surface={native ? "desktop-chat" : undefined}
    >
      <button
        ref={anchor}
        type="button"
        className={`${open ? "open" : ""} ${collapsed ? "cowork-place-collapsed" : chosen ? "cowork-place-chosen" : ""}`}
        aria-label={collapsed ? label : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
      >
        {(collapsed || (!native && chosen)) && (
          <AppIcon name="Projects" size={16} />
        )}
        {!collapsed && (
          <>
            <span data-no-translate={chosen || undefined}>{label}</span>
            <AppIcon name="CaretDown" size={12} />
          </>
        )}
        {collapsed && chosen && (
          <span className="cowork-place-badge" aria-hidden="true">
            {badgeCount}
          </span>
        )}
      </button>
    </div>
  );
}

export function usePlacePickerShell() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
  };
  useDismiss([anchor, popup], open, close);
  return {
    open,
    anchor,
    popup,
    close,
    toggle: () => setOpen((value) => !value),
  };
}
