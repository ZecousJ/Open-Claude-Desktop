/** Stop: a ringed square. */
export function RingedStopIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="5.4"
        y="5.4"
        width="5.2"
        height="5.2"
        rx="1.2"
        fill="currentColor"
      />
    </svg>
  );
}
