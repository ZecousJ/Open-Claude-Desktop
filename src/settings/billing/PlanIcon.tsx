/**
 * The plan card's line drawing. Claudex's own drawing of a branching stem, not
 * the original artwork.
 */
export function PlanIcon() {
  const dots: [number, number][] = [
    [19, 25],
    [45, 25],
    [25, 36],
    [39, 36],
    [6.5, 46],
    [57.5, 46],
  ];
  return (
    <svg
      className="billing-plan-icon"
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="32" cy="11" r="7.5" />
      <circle cx="32" cy="11" r="3.5" />
      <path d="M32 18.5V58" />
      <path d="M32 31 22 27M32 31 42 27" />
      <path d="M32 41 27.5 38M32 41 36.5 38" />
      <path d="M32 50 9.5 46.5M32 50 54.5 46.5" />
      <path d="M32 58 23 53.5M32 58 41 53.5" />
      {dots.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3" />
      ))}
    </svg>
  );
}
