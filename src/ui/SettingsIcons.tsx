import { type LucideProps } from "lucide-react";

/* Glyphs the icon font has no equal for, drawn in the lucide 24px grid: the
   Memory mark of the project dialogs and the Settings search with no match. */
function Base({
  size = 24,
  children,
  ...rest
}: LucideProps & { children: React.ReactNode }) {
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
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Counter-clockwise history arrow around a wave (Memory). */
export function MemoryIcon(props: LucideProps) {
  return (
    <Base {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M7.6 12.9c.8-1 1.5-1 2.2 0s1.5 1 2.2 0 1.5-1 2.2 0" />
    </Base>
  );
}

/** Magnifier inside a ring. */
export function NoResultsIcon(props: LucideProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="11.2" cy="11.2" r="3.4" />
      <path d="m13.8 13.8 2.6 2.6" />
    </Base>
  );
}
