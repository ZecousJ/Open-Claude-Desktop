import {
  useEffect,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "../ui/app-icon";
import type { Mode } from "../../shared/types";
import { surface } from "../../shared/host";
import { NavItemBadge } from "./NavItemBadge";
import type { NavBadge } from "./navItems";
import { menuItems, roamMenuItems } from "./menu-keys";

function DesignRow({ onClick }: { onClick: () => void }) {
  return (
    <>
      <button role="menuitem" onClick={onClick}>
        {/* In the icon slot like the page rows, so it keeps their width. */}
        <span className="nav-glyph">
          <AppIcon name="Palette" />
        </span>
        <span>Design</span>
      </button>
    </>
  );
}

export function MoreNavPopup({
  menuRef,
  mode,
  position,
  pages,
  seen,
  onSeen,
  used,
  onUse,
  linkProps,
  onEditSidebar,
  onDesign,
  initialFocus,
  onTab,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  /** The menu's keys (arrows, Home, End, Escape: MainNav). */
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  mode: Mode;
  position: { left: number; top: number };
  pages: { id: string; label: string; icon: ReactNode; badge?: NavBadge }[];
  seen: string[];
  onSeen: (ids: string[]) => void;
  used: string[];
  onUse: (ids: string[]) => void;
  linkProps: (page: string) => {
    href?: string;
    onClick: MouseEventHandler<HTMLElement>;
    onAuxClick?: MouseEventHandler<HTMLElement>;
  };
  onEditSidebar: () => void;
  onDesign: () => void;
  /** Opened from the keyboard: the item that takes focus (↓ first, ↑ last). */
  initialFocus?: "first" | "last";
  /** Tab leaves the menu (it is rendered apart from the sidebar). */
  onTab?: () => void;
}) {
  useEffect(() => {
    if (!initialFocus) return;
    const items = menuRef.current ? menuItems(menuRef.current) : [];
    items[initialFocus === "first" ? 0 : items.length - 1]?.focus();
  }, []);
  useEffect(() => {
    const unseen = pages.filter(
      (item) => item.badge === "new-neutral" && !seen.includes(item.id),
    );
    if (!unseen.length) return;
    const nextSeen = [...seen, ...unseen.map((item) => item.id)];
    onSeen(nextSeen);
    try {
      localStorage.setItem("sidebar-seen-new-items", JSON.stringify(nextSeen));
    } catch {}
  }, [pages, seen, onSeen]);
  return createPortal(
    <div
      ref={menuRef}
      className="popover main-nav-more-menu"
      role="menu"
      style={position}
      onKeyDown={(event) => roamMenuItems(event, onTab)}
    >
      {mode !== "code" && <DesignRow onClick={onDesign} />}
      {pages.map((item) => {
        const link = linkProps(item.id);
        const Row = surface === "web" ? "a" : "button";
        return (
          <Row
            key={item.id}
            role="menuitem"
            {...link}
            onClick={(event) => {
              if (item.badge === "new-neutral") {
                const nextUsed = [...new Set([...used, item.id])];
                onUse(nextUsed);
                try {
                  localStorage.setItem(
                    "sidebar-used-new-items",
                    JSON.stringify(nextUsed),
                  );
                } catch {}
              }
              link.onClick(event);
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge && <NavItemBadge badge={item.badge} />}
          </Row>
        );
      })}
      <hr />
      <button role="menuitem" onClick={onEditSidebar}>
        {/* The icon slot stays, empty, so the label lines up with the rows. */}
        <span className="nav-glyph" aria-hidden="true" />
        <span>Edit sidebar…</span>
      </button>
    </div>,
    document.body,
  );
}
