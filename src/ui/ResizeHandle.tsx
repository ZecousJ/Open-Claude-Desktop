import type { HTMLAttributes, KeyboardEvent } from "react";

/** One arrow press moves the divider this far; with Shift, the larger step. */
export const RESIZE_STEP_PX = 8;
export const RESIZE_STEP_LARGE_PX = 32;

/**
 * The step an arrow key moves a divider by, in pixels along its axis (positive:
 * right or down), or undefined for other keys. Shift takes the larger step.
 */
export function resizeStep(
  key: string,
  shift: boolean,
  orientation: "vertical" | "horizontal" = "vertical",
) {
  const [back, forward] =
    orientation === "vertical"
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
  const step = shift ? RESIZE_STEP_LARGE_PX : RESIZE_STEP_PX;
  return key === back ? -step : key === forward ? step : undefined;
}

/**
 * The divider every resizable panel uses, after the original's ResizeHandle: a
 * 12px grab area with a 3×48px pill in its middle. The pill fades in (200ms,
 * after 200ms of hover) in the muted text colour, turns the secondary colour
 * while dragged (120ms) and, on keyboard focus, the accent colour along the
 * whole edge at once. The arrows move it 8px (32px with Shift); Enter or Space
 * acts as a click on it. The caller does the dragging (pointer handlers through
 * `rest`) and positions the handle with its own class.
 */
export function ResizeHandle({
  label,
  orientation = "vertical",
  dragging = false,
  className = "",
  onStep,
  onActivate,
  onKeyDown,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "role"> & {
  label: string;
  /** "vertical": a divider between columns, dragged sideways. */
  orientation?: "vertical" | "horizontal";
  dragging?: boolean;
  /** An arrow key: move the divider by this many pixels along its axis. */
  onStep: (pixels: number) => void;
  /** Enter or Space. */
  onActivate?: () => void;
}) {
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.key === "Enter" || event.key === " ") && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) onActivate?.();
      return;
    }
    const step = resizeStep(event.key, event.shiftKey, orientation);
    if (step === undefined) return;
    event.preventDefault();
    onStep(step);
  };
  return (
    <div
      {...rest}
      className={`resize-handle ${className}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      data-orientation={orientation}
      data-dragging={dragging || undefined}
      tabIndex={0}
      onKeyDown={key}
    >
      <span className="resize-handle-pill" aria-hidden="true" />
    </div>
  );
}
