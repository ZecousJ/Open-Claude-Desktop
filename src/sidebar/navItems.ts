import type { Mode } from "../../shared/types";

export type NavItemId =
  | "projects"
  | "artifacts"
  | "scheduled"
  | "customize"
  | "api"
  | "status"
  | "dispatch";

export type NavBadge =
  "beta" | "ant" | "lab" | "preview" | "new" | "new-neutral";

export interface SidebarNavItem {
  id: NavItemId;
  label: string;
  surfaces: Mode[];
  badge?: NavBadge;
}

export const navItems: SidebarNavItem[] = [
  { id: "dispatch", label: "Dispatch", surfaces: ["chat", "cowork"] },
  { id: "projects", label: "Projects", surfaces: ["chat", "cowork"] },
  { id: "artifacts", label: "Artifacts", surfaces: ["chat", "cowork", "code"] },
  { id: "scheduled", label: "Scheduled", surfaces: ["chat", "cowork", "code"] },
  { id: "customize", label: "Customize", surfaces: ["chat", "cowork", "code"] },
  // Not in claude.ai: the service group and API keys of a Claudex account.
  { id: "api", label: "API", surfaces: ["chat", "cowork", "code"] },
  // Not in claude.ai: the service's channels and incidents.
  {
    id: "status",
    label: "Service status",
    surfaces: ["chat", "cowork", "code"],
  },
];

export function defaultHiddenNavItemsFor(mode: Mode) {
  return mode === "code"
    ? [...defaultHiddenNavItems, "scheduled"]
    : [...defaultHiddenNavItems];
}

/**
 * Dispatch lives in More. The unified chat's four primary collection links stay
 * visible, including for saved legacy preferences; API and Service status sit
 * with them on the sidebar in every mode.
 */
export const defaultHiddenNavItems: readonly NavItemId[] = ["dispatch"];

/**
 * The rows a surface offers, split into those shown and those moved into More.
 * Cowork has its own mode entry; it is not a Chat alias.
 */
export function sidebarNav(
  mode: Mode,
  hidden?: readonly string[],
  hub = false,
) {
  const hiddenIds = hidden ?? defaultHiddenNavItemsFor(mode);
  // Claudex shares its scheduler across modes; Routines is the non-unified
  // scheduler's Code label. Dispatch has no row; Customize and Scheduled live
  // in More.
  const available = navItems.filter(
    (item) => item.surfaces.includes(mode) && item.id !== "dispatch",
  );
  const secondary = (id: NavItemId) => id === "customize" || id === "scheduled";
  const offered = available.filter((item) => !secondary(item.id));
  return {
    offered,
    shown: offered.filter(
      (item) =>
        isFixedNavItem(mode, item.id, hub) || !hiddenIds.includes(item.id),
    ),
    inMore: available.filter(
      (item) =>
        secondary(item.id) ||
        (!isFixedNavItem(mode, item.id, hub) && hiddenIds.includes(item.id)),
    ),
  };
}

/** Unified home fixes Scheduled in Code too. */
export function isFixedNavItem(mode: Mode, id: NavItemId, _hub: boolean) {
  // API and Service status are always on the sidebar.
  if (id === "api" || id === "status") return true;
  return mode !== "code" && ["projects", "artifacts"].includes(id);
}

export function navBadgeLabel(badge: NavBadge) {
  switch (badge) {
    case "beta":
      return "Beta";
    case "ant":
    case "lab":
      return "Internal only";
    case "preview":
      return "Preview";
    default:
      return "New";
  }
}

/** The selected hidden row names More. */
export function moreNavState<
  Item extends { id: string; label: string; badge?: NavBadge },
>(items: readonly Item[], page: string, seen: readonly string[] = []) {
  return {
    selected: items.find((item) => item.id === page),
    hasUnseenNew: items.some(
      (item) => item.badge === "new-neutral" && !seen.includes(item.id),
    ),
  };
}

/** The hidden list after showing or hiding one row. */
export function toggleNavItem(
  hidden: readonly string[] = defaultHiddenNavItems,
  id: NavItemId,
  show: boolean,
  fixed = false,
) {
  if (fixed) return [...hidden];
  const rest = hidden.filter((value) => value !== id);
  return show ? rest : [...rest, id];
}
