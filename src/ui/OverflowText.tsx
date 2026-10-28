import type { ElementType, ReactNode } from "react";
import { useTooltip } from "./Tooltip";
import type { TooltipPlacement } from "./tooltip-position";

/**
 * Text that is cut with an ellipsis and says the whole of itself in the shared
 * tooltip, only while it is cut. The browser's native `title` shows at once and
 * whether or not anything is cut. The element needs its own ellipsis
 * (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`).
 */
export function OverflowText({
  text,
  children = text,
  as: Tag = "span",
  className,
  placement = "above",
  noTranslate = false,
}: {
  /** The whole text, as the tooltip shows it. */
  text: string;
  /** What is drawn, when it is a shortened form of `text`. */
  children?: ReactNode;
  as?: ElementType;
  className?: string;
  placement?: TooltipPlacement;
  /** A name (a folder's, a file's), never put through the interface translation. */
  noTranslate?: boolean;
}) {
  const { props, tooltip } = useTooltip(text, { placement });
  return (
    <>
      <Tag
        className={className}
        data-no-translate={noTranslate || undefined}
        aria-describedby={props["aria-describedby"]}
        onPointerEnter={(event: { currentTarget: HTMLElement }) => {
          const element = event.currentTarget;
          if (element.scrollWidth > element.clientWidth)
            props.onPointerEnter(event);
        }}
        onPointerLeave={props.onPointerLeave}
        onPointerDown={props.onPointerDown}
      >
        {children}
      </Tag>
      {tooltip}
    </>
  );
}
