import type { CSSProperties, ReactNode } from "react";
import "./template-artwork.css";

/** Positioned artwork from the observed gallery tiles (2026-10-19). Source
 * rem coordinates use a 16px basis; pixels keep them stable at this app's
 * 14px root. Hidden motion layers retain their captured idle state. */
export function Part({
  box,
  fill,
  hidden,
  clip,
  origin,
  part,
  style,
  children,
}: {
  box?: [
    left: number,
    top: number,
    width: number,
    height: number,
    radius: number,
  ];
  fill?: string;
  hidden?: boolean;
  clip?: boolean;
  origin?: string;
  part?: string;
  style?: CSSProperties & Record<string, unknown>;
  children?: ReactNode;
}) {
  return (
    <span
      className="artifacts-template-part"
      data-motion-part={part}
      style={{
        ...(box
          ? {
              left: box[0],
              top: box[1],
              width: box[2],
              height: box[3],
              borderRadius: box[4],
            }
          : {}),
        ...(fill ? { backgroundColor: fill } : {}),
        ...(hidden ? { opacity: 0 } : {}),
        ...(clip ? { overflow: "hidden" } : {}),
        ...(origin ? { transformOrigin: origin } : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Cursor({ color = "#000" }: { color?: string }) {
  const path = "M1.5 1.5L1.5 12.5L4.6 9.8L6.9 14.3L8.9 13.4L6.7 9L11 9Z";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 16"
      width="12"
      height="13.5"
      className="artifacts-template-cursor"
    >
      <path
        d={path}
        fill="none"
        stroke="white"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d={path}
        fill={color}
        stroke={color}
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
