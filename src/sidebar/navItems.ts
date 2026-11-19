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
 * Dispatch lives in More. The unified chat's four primary collection links
 * stay visible, including for saved legacy preferences (owner handover and
 * live capture, 2026-10-16); API and Service status sit with them on the
 * sidebar in every mode (owner, 2026-10-20).
 */
export const defaultHiddenNavItems: readonly NavItemId[] = ["dispatch"];

/**
 * The rows a surface offers, split into those shown and those moved into
 * More (R-0018). Cowork has its own mode entry; it is not a Chat alias
 * (live claude.ai bundle, 2026-10-14, shared-20-BCaQhdKH.js).
 */
export function sidebarNav(
  mode: Mode,
  hidden?: readonly string[],
  hub = false,
) {
  const hiddenIds = hidden ?? defaultHiddenNavItemsFor(mode);
  // Claudex shares its scheduler across modes; Routines is the non-unified
  // scheduler's Code label (live claude.ai bundle, 2026-10-14, shared-20-BCaQhdKH.js; shared-16-CBfjFjLo.js).
  // Dispatch has no row (owner, 2026-10-22); Customize and Scheduled live
  // in More (owner, 2026-10-22: "自定义和定时任务塞到更多").
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

/** Unified home fixes Scheduled in Code too (live claude.ai bundle, 2026-10-14, shared-l-0-DFIwPMy1.js). */
export function isFixedNavItem(mode: Mode, id: NavItemId, _hub: boolean) {
  // API and Service status are always on the sidebar (owner, 2026-10-20).
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

/** The selected hidden row names More (live claude.ai bundle, 2026-10-14, shared-21-Cj1zQ-fC.js). */
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
