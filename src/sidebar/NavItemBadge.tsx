import { navBadgeLabel, type NavBadge } from "./navItems";

export function NavItemBadge({ badge }: { badge: NavBadge }) {
  return badge === "new" || badge === "lab" ? null : (
    <span className="main-nav-badge">{navBadgeLabel(badge)}</span>
  );
}
