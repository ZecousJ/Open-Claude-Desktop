import { formatText, t } from "../i18n";

// Palette order.
export const avatarVariants = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 33, 35, 36, 37, 38, 39, 40, 41,
  42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
  61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72,
];

// Six shapes, twelve background/foreground pairs; Hourglass variants 33/34 swap
// pairs. English names/template were read from the official picker, not
// inferred IDs.
const avatarShapes = [
  "Flower",
  "Grid",
  "Hourglass",
  "Square",
  "Stairs",
  "Star",
];
const avatarPalette = [
  ["sage green", "olive green"],
  ["sage green", "blue"],
  ["pink", "lavender"],
  ["pink", "beige"],
  ["lavender", "pink"],
  ["lavender", "blue"],
  ["beige", "pink"],
  ["beige", "olive green"],
  ["olive green", "sage green"],
  ["olive green", "beige"],
  ["blue", "sage green"],
  ["blue", "lavender"],
];

export function avatarLabel(variant: number) {
  if (!Number.isInteger(variant) || variant < 1 || variant > 72)
    return t("Avatar");
  const pair = variant === 33 ? 9 : variant === 34 ? 8 : (variant - 1) % 12;
  const [background, foreground] = avatarPalette[pair];
  return formatText("{shape}, {foreground} on {background}", {
    shape: t(avatarShapes[Math.floor((variant - 1) / 12)]),
    foreground: t(foreground),
    background: t(background),
  });
}
