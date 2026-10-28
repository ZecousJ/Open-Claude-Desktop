import { useEffect, useState, type ReactNode } from "react";

/** How long the content stays mounted after it starts to close: the
 *  default --expand-duration (--motion-base, styles/05-utilities.css). */
export const COLLAPSE_MS = 200;

/**
 * What a collapsible section renders: whether its content is mounted and
 * whether it is drawn open. Opening mounts the content closed and opens it
 * a frame later, so the row grows from nothing; closing draws it closed and
 * unmounts it once the row has shut.
 */
export function useCollapse(open: boolean, exitMs = COLLAPSE_MS) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: the first paints the mounted, closed row.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setExpanded(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted, expanded };
}

/**
 * A section that opens to its content's height and closes back, fading as
 * it goes (.u-expand-rows). The content stays mounted while it closes.
 * `className` styles the outer row; retime it with --expand-duration and
 * --expand-ease, and pass the same length as `exitMs`.
 */
export function Collapsible({
  open,
  children,
  className = "",
  exitMs = COLLAPSE_MS,
  id,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  exitMs?: number;
  id?: string;
}) {
  const { mounted, expanded } = useCollapse(open, exitMs);
  if (!mounted) return null;
  return (
    <div
      id={id}
      className={`u-expand-rows${className ? ` ${className}` : ""}`}
      data-open={expanded}
      inert={!open || undefined}
    >
      <div>{children}</div>
    </div>
  );
}
