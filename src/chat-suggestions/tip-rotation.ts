export const tipRotationMs = 5000;
export interface TipRotation {
  index: number;
  shownAt: number;
}
const rotations = new Map<string, TipRotation>();

export function rememberTipRotation(key: string, rotation: TipRotation) {
  rotations.delete(key);
  if (rotations.size >= 200) rotations.delete(rotations.keys().next().value!);
  rotations.set(key, rotation);
}

export function initialTipRotation(
  key: string,
  count: number,
  now: number,
): TipRotation {
  if (count < 2) return { index: 0, shownAt: now };
  const previous = rotations.get(key);
  const rotation = !previous
    ? { index: 0, shownAt: now }
    : now - previous.shownAt < tipRotationMs
      ? { index: previous.index % count, shownAt: previous.shownAt }
      : { index: (previous.index + 1) % count, shownAt: now };
  rememberTipRotation(key, rotation);
  return rotation;
}
