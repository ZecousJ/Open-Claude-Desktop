import type { SVGProps } from "react";

// Simple hand-drawn outline icons for Artifact chrome shapes lucide does not provide.
type IconProps = SVGProps<SVGSVGElement> & { size?: number };
function Outline({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/**
 * Two round speech bubbles: the front one on the upper left, the rear one lower
 * right. `filled` is the comment-mode form: both solid, the front one cut out
 * of the rear one by the button's own colour (`gap`).
 */
export function CommentBubblesIcon({
  filled,
  gap = "#0a2243",
  ...props
}: IconProps & { filled?: boolean; gap?: string }) {
  if (filled)
    return (
      <Outline {...props}>
        <path
          d="M20.3 14.4a5.3 5.3 0 1 0-2.4 4.4l3 .9-.9-3a5.3 5.3 0 0 0 .3-2.3Z"
          fill="currentColor"
        />
        <path
          d="M9.5 3.5a6 6 0 0 1 5.9 7.1 6 6 0 0 1-8.4 4.3L3.5 16l1.1-3.3A6 6 0 0 1 9.5 3.5Z"
          fill="currentColor"
          stroke={gap}
          strokeWidth={2.5}
        />
      </Outline>
    );
  return (
    <Outline {...props}>
      <path d="M9.5 3.5a6 6 0 0 1 5.9 7.1 6 6 0 0 1-8.4 4.3L3.5 16l1.1-3.3A6 6 0 0 1 9.5 3.5Z" />
      <path d="M16.9 9.2a5 5 0 0 1 2.9 7.7l.9 3.3-3.3-.9a5 5 0 0 1-6.3-1.8" />
    </Outline>
  );
}

/** Front square on the upper left over a rear square offset to the lower right. */
export function CopyStackIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <rect x="3" y="3" width="13" height="13" rx="2" />
      <path d="M8 16v3a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-3" />
    </Outline>
  );
}

/** Front window on the lower left with a rear window offset to the upper right. */
export function PopOutWindowsIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <rect x="3" y="8" width="13" height="13" rx="2" />
      <path d="M3 12h13" />
      <path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" />
    </Outline>
  );
}

const pinBody = (
  <g transform="rotate(45 12 12)">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </g>
);

/** A push pin tilted with its head to the upper right. */
export function TiltedPinIcon(props: IconProps) {
  return <Outline {...props}>{pinBody}</Outline>;
}

/** The tilted pin struck through from the upper left. */
export function TiltedUnpinIcon(props: IconProps) {
  return (
    <Outline {...props}>
      {pinBody}
      <path d="m3 3 18 18" />
    </Outline>
  );
}

/** Two vertical slider tracks with knobs at different heights. */
export function FilterSlidersIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M8 3v4.5M8 12.5V21M16 3v8.5M16 16.5V21" />
      <circle cx="8" cy="10" r="2.5" />
      <circle cx="16" cy="14" r="2.5" />
    </Outline>
  );
}

/** Slides: a card behind another, on a 13px grid. */
export function SlidesIcon({
  size = 13,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 13 13"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      aria-hidden="true"
    >
      <path d="M4.5 8H2.5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v2" />
      <rect x="4.5" y="4.5" width="7.5" height="7" rx="1" />
    </svg>
  );
}
