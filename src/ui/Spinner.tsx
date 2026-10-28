import { useEffect, useState, type CSSProperties } from "react";
import "./spinner.css";

const sizes = {
  sm: { box: 12, stroke: 1.5 },
  md: { box: 16, stroke: 1.75 },
  lg: { box: 20, stroke: 2 },
};

// CDS Spinner.
export function Spinner({
  size = "sm",
  delay = 0,
  inheritColor = false,
  label,
  className = "",
  style,
}: {
  size?: keyof typeof sizes | number;
  delay?: number;
  inheritColor?: boolean;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [visible, setVisible] = useState(delay <= 0);
  const [previousDelay, setPreviousDelay] = useState(delay);
  const [announce, setAnnounce] = useState(false);
  if (previousDelay !== delay) {
    setPreviousDelay(delay);
    if (delay > 0 && visible) setVisible(false);
  }
  useEffect(() => {
    if (delay <= 0) return;
    const timeout = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timeout);
  }, [delay]);
  useEffect(() => {
    if (!label) return;
    const timeout = window.setTimeout(() => setAnnounce(true), 100);
    return () => window.clearTimeout(timeout);
  }, [label]);
  const { box, stroke } =
    sizes[
      typeof size === "number"
        ? size <= 12
          ? "sm"
          : size <= 16
            ? "md"
            : "lg"
        : size
    ];
  const color = inheritColor ? "currentColor" : "var(--text-muted)";
  const track = inheritColor
    ? "color-mix(in srgb, currentColor 25%, transparent)"
    : "color-mix(in srgb, var(--alpha-ink) 10%, transparent)";
  const mask = `radial-gradient(farthest-side, transparent calc(100% - ${stroke}px), #000 calc(100% - ${stroke}px + 0.5px))`;
  const show = delay <= 0 || visible;
  const glyph = show ? (
    <span
      data-cds="Spinner"
      className={`cds-spinner ${className}`}
      style={{ ...style, width: box, height: box, animation: "none" }}
      aria-hidden="true"
    >
      <span
        className="cds-spinner-track"
        style={{ border: `${stroke}px solid ${track}` }}
      />
      <span
        className="cds-spinner-arc"
        style={{
          background: `conic-gradient(transparent 40%, ${color})`,
          WebkitMask: mask,
          mask,
        }}
      />
    </span>
  ) : null;
  return label ? (
    <span role="status" className="cds-spinner-status">
      {glyph}
      {show && announce && <span className="sr-only">{label}</span>}
    </span>
  ) : (
    glyph
  );
}
