/**
 * Research's icon (design R45 §4.1): a magnifying glass with a rising line
 * inside it, as the original's "+" menu row and composer chip draw it
 * (lucide has no match). Uses currentColor like the lucide icons around it.
 */
export function ResearchIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.25" />
      <path d="M10.9 10.9 14.25 14.25" />
      <path d="M4.4 8.3 6.1 6.6 7.5 8 9.6 5.7" />
    </svg>
  );
}
