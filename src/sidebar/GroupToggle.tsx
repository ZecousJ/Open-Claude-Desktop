import { AppIcon } from "../ui/app-icon";

/**
 * A Code group heading's name as a button that shows or hides the group's rows.
 * The caret is the section headings' (SectionLabel): CaretRight on every
 * surface.
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
      <AppIcon name="CaretRight" />
    </button>
  );
}
