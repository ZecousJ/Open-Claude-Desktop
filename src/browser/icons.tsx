/**
 * The Browser panel's own glyphs: the dev servers button is a rounded box split
 * across the middle with a short stroke in its upper half (15px). The other
 * icons are lucide's.
 */
export function DevServersIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="10" height="10" rx="1.6" />
      <path d="M2.5 7.5h10M9 5h1.6" />
    </svg>
  );
}
