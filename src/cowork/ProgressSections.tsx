import { type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../ui/glyphs";
import "./folder-instructions.css";

export function Section({
  title,
  open,
  onToggle,
  after,
  action,
  children,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Muted text at the heading's right end ("4 of 4"). */
  after?: ReactNode;
  /** A button at the heading's right end (outside the toggle). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="progress-section">
      <div className="progress-section-header">
        <button
          className="progress-section-heading"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="progress-section-title">{title}</span>
          {!action &&
            (open ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
          {after && <span className="progress-section-after">{after}</span>}
        </button>
        {action && (
          <>
            <button
              className="progress-section-chevron"
              aria-hidden="true"
              tabIndex={-1}
              onClick={onToggle}
            >
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {action}
          </>
        )}
      </div>
      {open && <div className="progress-section-body">{children}</div>}
    </section>
  );
}

/**
 * The empty Context picture: two small sheets, a raised one with a plus and a
 * dotted slot behind it.
 */
export function ContextPlaceholder() {
  const lines = (x: number, y: number, w: number) => (
    <path
      d={`M${x} ${y}q1.5 -1.4 3 0t3 0t3 0t3 0${w > 12 ? "t3 0t3 0" : ""}M${x} ${y + 3.5}q1.5 -1.4 3 0t3 0t3 0t3 0${w > 12 ? "t3 0" : ""}M${x} ${y + 7}q1.5 -1.4 3 0t3 0t3 0`}
    />
  );
  return (
    <svg
      className="progress-context-picture"
      width="101"
      height="50"
      viewBox="0 0 101 50"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="69"
        y="17"
        width="30"
        height="30"
        rx="5"
        strokeDasharray="1.5 1.5"
      />
      <rect x="1" y="17" width="30" height="30" rx="5" className="sheet" />
      <rect x="35" y="17" width="30" height="30" rx="5" className="sheet" />
      <g transform="rotate(4 74 20)">
        <rect
          x="58"
          y="1"
          width="36"
          height="36"
          rx="5"
          className="sheet raised"
        />
        <g className="scribble">{lines(64, 8, 18)}</g>
        <circle cx="68" cy="28" r="4.5" />
        <path d="M68 25.8v4.4M65.8 28h4.4" />
      </g>
      <g className="scribble">
        {lines(6, 26, 12)}
        {lines(40, 26, 12)}
      </g>
    </svg>
  );
}
