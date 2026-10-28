import { type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "../ui/glyphs";
import { t } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { WithTooltip } from "../ui/Tooltip";
import "./next-steps.css";

/**
 * The start card's suggestion list. Undefined slot keeps a standalone list; the
 * home's slot is that one ul and every piece portals its rows into it, in the
 * order given.
 */
export function StartCardRows({
  slot,
  children,
}: {
  slot: HTMLElement | null | undefined;
  children: ReactNode;
}) {
  return slot === undefined ? (
    <ul className="next-steps" aria-label={t("Next steps")}>
      {children}
    </ul>
  ) : slot ? (
    createPortal(children, slot)
  ) : null;
}

/** Row order across the pieces. */
export const startRowOrder = {
  nextSteps: 0,
  suggestedTasks: 1,
  cliImport: 2,
} as const;

/** One 32px row: glyph, title with its muted detail on the same line, and a × that shows on hover or focus. */
export function StartCardRow({
  icon,
  lead,
  title,
  detail,
  holds,
  tooltip,
  label,
  end,
  dismissLabel,
  order,
  className,
  rowClassName,
  dismissClassName,
  onPress,
  onDismiss,
}: {
  icon?: ReactNode;
  lead?: ReactNode;
  title: string;
  detail?: string;
  holds?: boolean;
  tooltip?: string;
  /** The row button's accessible name when the title alone does not say what pressing does. */
  label?: string;
  /** "chevron" opens something, "caret" opens a list, "spacer" acts in place, none ends the row. */
  end?: "chevron" | "spacer" | "caret";
  dismissLabel: string;
  /** Where the row sits among the other pieces' rows. */
  order: number;
  className?: string;
  rowClassName?: string;
  dismissClassName?: string;
  onPress: (event: MouseEvent<HTMLButtonElement>) => void;
  onDismiss: () => void;
}) {
  return (
    <li
      className={className ? `next-step ${className}` : "next-step"}
      style={{ order }}
    >
      <WithTooltip
        label={tooltip ?? title}
        placement="above"
        size="wrap"
        disabled={!tooltip}
      >
        {(tip) => (
          <button
            type="button"
            className={
              rowClassName ? `next-step-row ${rowClassName}` : "next-step-row"
            }
            aria-label={label}
            {...tip}
            onClick={onPress}
          >
            {icon}
            <span className="next-step-text">
              <span className="next-step-title" data-no-translate>
                {lead}
                {title}
              </span>
              {detail && (
                <span
                  className="next-step-detail"
                  data-holds={holds || undefined}
                >
                  {detail}
                </span>
              )}
            </span>
            {end === "caret" && (
              <span className="next-step-caret" aria-hidden="true">
                <AppIcon name="CaretDown" size={12} />
              </span>
            )}
            {end === "spacer" ? (
              <span className="next-step-spacer" aria-hidden="true" />
            ) : end === "chevron" ? (
              <span className="next-step-chevron" aria-hidden="true">
                <AppIcon name="CaretRight" />
              </span>
            ) : null}
          </button>
        )}
      </WithTooltip>
      <span className="next-step-dismiss">
        <WithTooltip label="Dismiss">
          {(tip) => (
            <button
              type="button"
              className={dismissClassName}
              aria-label={dismissLabel}
              {...tip}
              onClick={onDismiss}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </WithTooltip>
      </span>
    </li>
  );
}
