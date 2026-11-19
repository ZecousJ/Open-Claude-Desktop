import { Anthropicon } from "../ui/anthropicons";

/**
 * A Code group heading's name as a button that shows or hides the group's
 * rows (live claude.ai bundle, 2026-10-12: the session list's group label
 * is a `data-group-toggle` button with its caret, hidden while the group is
 * open until the heading is hovered or focused, and turned while it is
 * open). The caret is the section headings' (SectionLabel): CaretRight on
 * every surface (desktop bundle 2.37337.1, shared-18-DScmD_-G.js).
 */
export function GroupToggle({
  label,
  collapsed,
  onToggle,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="group-toggle"
      data-group-toggle=""
      data-roving-item=""
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span>{label}</span>
      <Anthropicon name="CaretRight" />
    </button>
  );
}
