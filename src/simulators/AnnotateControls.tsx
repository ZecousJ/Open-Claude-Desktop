import { type ReactNode } from "react";
import { useTooltip } from "../ui/Tooltip";
import { type RedactStyle } from "./annotate-sketch";
import "./annotate-image.css";

/** The swatch of a redaction style: black, or a small grid of greys. */
export function styleSwatch(style: RedactStyle) {
  if (style === "solid") return "#000000";
  const cells = style === "mosaic" ? 3 : 7;
  const greys =
    style === "mosaic"
      ? ["#4a4a4a", "#bdbdbd", "#7c7c7c", "#a3a3a3", "#5e5e5e"]
      : ["#1e1e1e", "#e2e2e2", "#6a6a6a", "#b8b8b8", "#3c3c3c", "#8e8e8e"];
  const size = 14 / cells;
  let rects = "";
  for (let i = 0; i < cells * cells; i++)
    rects += `<rect x='${(i % cells) * size}' y='${Math.floor(i / cells) * size}' width='${size}' height='${size}' fill='${greys[(i * 7 + (i >> 2)) % greys.length]}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'>${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / cover`;
}

export function ToolButton({
  label,
  pressed,
  disabled,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string[];
  onClick: () => void;
  children: ReactNode;
}) {
  const { props, tooltip } = useTooltip(label, {
    shortcut,
    placement: "above",
  });
  return (
    <>
      <button
        {...props}
        type="button"
        className={`icon-button annotate-tool ${pressed ? "active" : ""}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
      {tooltip}
    </>
  );
}

export function Swatch({
  label,
  fill,
  active,
  square,
  onPick,
}: {
  label: string;
  fill: string;
  active: boolean;
  square: boolean;
  onPick: () => void;
}) {
  const { props, tooltip } = useTooltip(label, { placement: "above" });
  return (
    <>
      <button
        {...props}
        type="button"
        className={`annotate-swatch ${square ? "square" : ""}`}
        aria-label={label}
        aria-pressed={active}
        onClick={onPick}
      >
        <span
          aria-hidden="true"
          className={`annotate-swatch-fill ${active ? "active" : ""} ${fill === "#FFFFFF" ? "light" : ""}`}
          style={{ background: fill }}
        />
      </button>
      {tooltip}
    </>
  );
}
