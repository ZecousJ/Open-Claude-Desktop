/*
 * The Claudex mark: the knot of six outlined petals from the app icon
 * (build/icon.svg). Its paths live in a 1024 square around (512, 512); the
 * knot spans about 151–873 of it.
 */
export const KNOT_PATHS = [
  "M392 492C282 362 362 182 582 162 632 262 622 402 392 492Z",
  "M469.3 398.1C526.9 237.8 722.8 217.1 850.1 397.6 788.5 490.9 662.3 552.3 469.3 398.1Z",
  "M589.3 418.1C756.9 387.8 872.8 547.1 780.1 747.6 668.5 740.9 552.3 662.3 589.3 418.1Z",
  "M632 532C742 662 662 842 442 862 392 762 402 622 632 532Z",
  "M554.7 625.9C497.1 786.2 301.2 806.9 173.9 626.4 235.5 533.1 361.7 471.7 554.7 625.9Z",
  "M434.7 605.9C267.1 636.2 151.2 476.9 243.9 276.4 355.5 283.1 471.7 361.7 434.7 605.9Z",
] as const;

/** The knot's view box, its stroke included. */
export const KNOT_VIEW_BOX = "120 120 784 784";

/** The knot as an <svg> string for pages built outside React. */
export function knotMarkup({
  size,
  color = "#d97757",
  strokeWidth = 64,
  className,
}: {
  size: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
}) {
  const paths = KNOT_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return `<svg${className ? ` class="${className}"` : ""} width="${size}" height="${size}" viewBox="${KNOT_VIEW_BOX}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
