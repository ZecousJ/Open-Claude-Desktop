import { type ReactNode, type RefObject } from "react";
import { AppIcon } from "../ui/app-icon";
import { GroupToggle } from "./GroupToggle";

/**
 * A group's heading in the recent list: its name, which in Code shows and
 * hides the group's rows.
 */
export function GroupLabel({
  label,
  noTranslate,
  collapsed,
  onToggle,
}: {
  label: string;
  noTranslate: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={`row-group-label${onToggle ? " has-toggle" : ""}`}
      data-roving-row=""
      data-drag-shift=""
      data-no-translate={noTranslate || undefined}
    >
      {onToggle ? (
        <GroupToggle
          label={label}
          collapsed={Boolean(collapsed)}
          onToggle={onToggle}
        />
      ) : (
        <span>{label}</span>
      )}
    </div>
  );
}

/** Section heading; on hover its chevron collapses the section. */
export function CodeRecentSortSlot({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return collapsed ? (
    <span className="code-recents-sort">{children}</span>
  ) : (
    <>{children}</>
  );
}

export function SectionLabel({
  label,
  labelRef,
  className = "",
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  /** The heading row, for what points at it (the drag tip). */
  labelRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      ref={labelRef}
      className={`section-label ${className}`}
      data-roving-row=""
      data-drag-shift=""
    >
      <button
        className={`section-toggle ${collapsed ? "collapsed" : ""}`}
        data-roving-item=""
        data-group-toggle=""
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span>{label}</span>
        <AppIcon name="CaretRight" />
      </button>
      {children && <div>{children}</div>}
    </div>
  );
}
