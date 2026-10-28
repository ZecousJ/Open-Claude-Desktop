import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useReplyTooltipClamp } from "../ui/useReplyTooltipClamp";

export function ReplyToolbarButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
  className = "",
  tooltip: tooltipText,
}: {
  label: string;
  /** What the tooltip says when it is not the label (Read aloud's "Loading…"). */
  tooltip?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  const [tooltip, setTooltip] = useState(false),
    id = useId();
  const tip = useReplyTooltipClamp(tooltip, tooltipText ?? label);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hide = () => {
    clearTimeout(timer.current);
    setTooltip(false);
  };
  const show = () => {
    clearTimeout(timer.current);
    if (!disabled) timer.current = setTimeout(() => setTooltip(true), 300);
  };
  return (
    <button
      className={`small-action icon-only ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      aria-describedby={tooltip ? id : undefined}
      disabled={disabled}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          hide();
          event.stopPropagation();
        }
      }}
      onClick={() => {
        hide();
        onClick();
      }}
    >
      {children}
      <span
        ref={tip}
        id={id}
        role="tooltip"
        className="copy-tooltip"
        data-open={tooltip}
      >
        {tooltipText ?? label}
      </span>
    </button>
  );
}
