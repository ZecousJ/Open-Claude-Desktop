import {
  Suspense,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { surface } from "../../shared/host";
import type { Conversation, Mode } from "../../shared/types";
import { isMacPlatform } from "../host/keys";
import { useHost } from "../host/HostContext";
import { coworkAvailable } from "../home/home-mode";
import { urlForState } from "../web/routes";
import { CircledPlusIcon, PlusIcon } from "../ui/icons";
import { AppIcon } from "../ui/app-icon";
import { AppContext } from "../app/AppContext";
import { useDismiss } from "../ui/useDismiss";
import { ShortcutPlatform, shortcutText, useTooltip } from "../ui/Tooltip";
import {
  sidebarNav,
  moreNavState,
  navBadgeLabel,
  type NavItemId,
  type NavBadge,
} from "./navItems";
import { formatText } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { NavItemBadge } from "./NavItemBadge";
import {
  requestArtifactDesign,
  requestProject,
} from "../collections/open-requests";
import { NavCreateMenu } from "./NavCreateMenu";

const web = surface === "web";
/**
 * The More menu opens 120ms after the pointer rests on its row and closes 180ms
 * after it leaves.
 */
export const moreHoverOpenMs = 120;
export const moreHoverCloseMs = 180;
const MoreNavPopup = lazyPiece(() => import("./MoreNavPopup"), "MoreNavPopup");

function readNavItemIds(key: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** A web row's glyph in its 28px slot. */
const slot = (glyph: ReactNode, className = "") => (
  <span className={`nav-glyph ${className}`}>{glyph}</span>
);

/**
 * Both surfaces use the same glyphs. API and Service status, on the sidebar
 * beside them, take the same set's Key and Activity.
 */
const icons: Record<NavItemId, ReactNode> = web
  ? {
      projects: slot(<AppIcon name="Projects" />),
      artifacts: slot(<AppIcon name="Artifacts" />),
      scheduled: slot(<AppIcon name="Clock" />),
      customize: slot(<AppIcon name="Tool" />),
      api: slot(<AppIcon name="Key" />),
      status: slot(<AppIcon name="Activity" />),
      dispatch: slot(<AppIcon name="Dispatch" />),
    }
  : {
      // The desktop's glyphs sit in the same 24px slot as the web's, so every
      // row's label starts at the same place.
      projects: slot(<AppIcon name="Projects" />),
      artifacts: slot(<AppIcon name="Artifacts" />),
      scheduled: slot(<AppIcon name="Clock" />),
      customize: slot(<AppIcon name="Tool" />),
      api: slot(<AppIcon name="Key" />),
      status: slot(<AppIcon name="Activity" />),
      dispatch: slot(<AppIcon name="Dispatch" />),
    };

/**
 * On the web, a row's own address (src/web/routes.ts): ⌘/Ctrl/Shift-click
 * and middle-click open it in a new browser tab, as a link would.
 */
function webLink(mode: Mode, page: string, onClick: () => void) {
  const href = web ? urlForState({ page, mode }) : undefined;
  if (!href) return { onClick };
  return {
    href,
    onClick: (event: MouseEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.button !== 0
      )
        return;
      event.preventDefault();
      onClick();
    },
  };
}

/**
 * The New row's shortcut hint: ⌘N (Ctrl+N on Windows and Linux), or on the
 * web ⇧⌘O (the browser keeps ⌘N).
 */
function newChatHint(desktopPlatform: string) {
  if (!web) return shortcutText(desktopPlatform, ["mod", "N"]);
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData
      ?.platform || navigator.platform;
  return isMacPlatform(platform)
    ? "⇧ ⌘ O"
    : shortcutText("win32", ["mod", "shift", "O"]);
}

function NavItem({
  className = "",
  current,
  icon,
  label,
  mode,
  page,
  onClick,
  children,
}: {
  className?: string;
  current?: boolean;
  icon: ReactNode;
  label: string;
  mode: Mode;
  /** The page the row opens ("chat" for New), for its web address. */
  page: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  const Row = web ? "a" : "button";
  return (
    <Row
      className={`nav-item ${className} ${current ? "current" : ""}`}
      aria-current={current ? "page" : undefined}
      {...webLink(mode, page, onClick)}
    >
      {icon}
      <span>{label}</span>
      {children}
    </Row>
  );
}

/**
 * The plus at the right end of the hovered Projects row: starts a new project.
 * A sibling of the row's button, at the New row's window icon's position.
 */
function NewProjectPlus() {
  const app = useContext(AppContext);
  const tip = useTooltip("New project");
  return (
    <>
      <button
        {...tip.props}
        className="main-nav-row-plus"
        aria-label="New project"
        onClick={() => app?.startProject()}
      >
        <PlusIcon />
      </button>
      {tip.tooltip}
    </>
  );
}

/** New navigates directly; collection rows have separate create menus. */
export function MainNav({
  mode,
  page,
  activeConversation,
  hiddenItems,
  onNewChat,
  onPageChange,
  onEditSidebar,
}: {
  mode: Mode;
  page: string;
  activeConversation?: Conversation;
  hiddenItems?: string[];
  onNewChat: () => void;
  onPageChange: (page: string) => void;
  onEditSidebar: () => void;
}) {
  const shortcutPlatform = useContext(ShortcutPlatform);
  const hub = coworkAvailable(useHost());
  const { shown, inMore } = sidebarNav(mode, hiddenItems, hub);
  return (
    <nav className="main-nav">
      <NavItem
        className={`new ${activeConversation ? "circled" : ""}`}
        current={!activeConversation && page === "chat"}
        // While a conversation is open New shows a circled plus; the web's Add
        // sits in a 22px disc that fills while one is open.
        icon={
          web
            ? slot(
                <span>
                  <AppIcon name="Add" />
                </span>,
                "add",
              )
            : activeConversation
              ? slot(<CircledPlusIcon />, "add")
              : slot(<PlusIcon />, "add")
        }
        label="New"
        mode={mode}
        page="chat"
        onClick={onNewChat}
      >
        <kbd>{newChatHint(shortcutPlatform)}</kbd>
      </NavItem>
      {shown.map((item) => (
        <div className="main-nav-item-wrap" key={item.id}>
          <NavItem
            className={item.id === "projects" ? "projects" : ""}
            current={page === item.id}
            icon={icons[item.id]}
            label={item.label}
            mode={mode}
            page={item.id}
            onClick={() => {
              if (item.id === "projects") requestProject();
              onPageChange(item.id);
            }}
          >
            {item.badge && <NavItemBadge badge={item.badge} />}
          </NavItem>
          {item.id === "projects" && <NewProjectPlus />}
          {(item.id === "artifacts" || item.id === "scheduled") && (
            <NavCreateMenu kind={item.id} />
          )}
        </div>
      ))}
      <MoreMenu
        mode={mode}
        page={page}
        extra={inMore.map((item) => ({
          ...item,
          icon: icons[item.id],
        }))}
        onPageChange={onPageChange}
        onEditSidebar={onEditSidebar}
      />
    </nav>
  );
}

export function MoreMenu({
  mode,
  page,
  extra,
  onPageChange,
  onEditSidebar,
}: {
  mode: Mode;
  page: string;
  extra: { id: string; label: string; icon: ReactNode; badge?: NavBadge }[];
  onPageChange: (page: string) => void;
  onEditSidebar: () => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() =>
    readNavItemIds("sidebar-seen-new-items"),
  );
  const [used, setUsed] = useState(() =>
    readNavItemIds("sidebar-used-new-items"),
  );
  const open = position !== undefined;
  // A menu the pointer opened closes when it leaves; a click keeps it open.
  const sticky = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = () => clearTimeout(hoverTimer.current);
  useEffect(() => settle, []);
  const trigger = useRef<HTMLButtonElement>(null);
  const [entry, setEntry] = useState<"first" | "last">();
  const close = () => {
    settle();
    sticky.current = false;
    // Focus that was inside the menu goes back to the row that opened it.
    if (menu.current?.contains(document.activeElement))
      trigger.current?.focus();
    setEntry(undefined);
    setPosition(undefined);
  };
  const openAt = (row: HTMLElement) => {
    const box = row.getBoundingClientRect();
    // Measured: 4px right of the row, top border level with it.
    setPosition({ left: box.right + 4, top: box.top });
  };
  const hover = (entering: boolean) => {
    settle();
    if (entering === open || sticky.current) return;
    const row = anchor.current?.querySelector("button");
    if (entering && !row) return;
    hoverTimer.current = setTimeout(
      () => (entering ? openAt(row!) : close()),
      entering ? moreHoverOpenMs : moreHoverCloseMs,
    );
  };
  useDismiss([anchor, menu], open, close);
  const go = (page: string) => {
    close();
    onPageChange(page);
  };
  const pages: typeof extra = [
    ...extra.map((item) =>
      item.badge === "new-neutral" && used.includes(item.id)
        ? { ...item, badge: undefined }
        : item,
    ),
  ];
  const { selected, hasUnseenNew } = moreNavState(pages, page, seen);
  const badge = selected?.badge;
  const ariaLabel = selected
    ? badge && badge !== "new"
      ? formatText(`{label}, ${navBadgeLabel(badge)}`, {
          label: formatText(selected.label),
        })
      : formatText(selected.label)
    : formatText("More navigation items");
  return (
    <div
      className="main-nav-more"
      ref={anchor}
      onPointerEnter={(event) => event.pointerType === "mouse" && hover(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && hover(false)}
    >
      <button
        className={selected ? "current" : open ? "open" : ""}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        ref={trigger}
        onKeyDown={(event) => {
          // ↓ opens onto the first item, ↑ onto the last.
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          settle();
          sticky.current = true;
          const first = event.key === "ArrowDown";
          if (open) {
            const items =
              menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
            items?.[first ? 0 : items.length - 1]?.focus();
            return;
          }
          setEntry(first ? "first" : "last");
          openAt(event.currentTarget);
        }}
        onClick={(event) => {
          settle();
          if (open && sticky.current) return close();
          sticky.current = true;
          // Enter and Space click with no pointer: focus goes into the menu.
          if (event.detail === 0) setEntry("first");
          if (!open) openAt(event.currentTarget);
        }}
      >
        {/* Chat's More is a caret, Code's three dots. */}
        {slot(
          <AppIcon name={mode === "code" ? "DotsHorizontal" : "CaretRight"} />,
        )}
        <span>{selected?.label ?? "More"}</span>
        {badge && <NavItemBadge badge={badge} />}
        {hasUnseenNew && !open && (
          <span
            className="main-nav-new-marker"
            role="img"
            aria-label={formatText("New items available")}
          />
        )}
      </button>
      {open && (
        <Suspense fallback={null}>
          <MoreNavPopup
            menuRef={menu}
            initialFocus={entry}
            onTab={close}
            mode={mode}
            position={position}
            pages={pages}
            seen={seen}
            onSeen={setSeen}
            used={used}
            onUse={setUsed}
            linkProps={(page) => webLink(mode, page, () => go(page))}
            onEditSidebar={() => {
              close();
              onEditSidebar();
            }}
            onDesign={() => {
              requestArtifactDesign();
              go("artifacts");
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
