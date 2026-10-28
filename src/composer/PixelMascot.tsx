/**
 * The pixel mascot standing on the Code composer, Claudex's own: two ears, a
 * body with short arms, two dark eyes and two feet on a 3px grid. Its native
 * artwork is 36 by 24; the web draft keeps the 80px animation slot, with
 * 36x24px visible art.
 */
export function PixelMascot({ webDraft = false }: { webDraft?: boolean }) {
  return (
    <svg
      className="pixel-mascot"
      viewBox={webDraft ? "0 0 80 80" : "0 0 36 24"}
      preserveAspectRatio="xMidYMax meet"
      width={webDraft ? "80" : "36"}
      height={webDraft ? "80" : "24"}
      aria-hidden="true"
    >
      <g transform={webDraft ? "translate(22 43)" : undefined}>
        <path
          fill="currentColor"
          d="M6 0h3v3h-3zM27 0h3v3h-3zM6 3h6v3h-6zM24 3h6v3h-6zM3 6h30v3h-30zM3 9h30v3h-30zM0 12h36v3h-36zM3 15h30v3h-30zM3 18h30v3h-30zM6 21h6v3h-6zM24 21h6v3h-6z"
        />
        <path fill="#070000" d="M9 9h3v3h-3zM24 9h3v3h-3z" />
      </g>
    </svg>
  );
}
