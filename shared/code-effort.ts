import type { CodeEffort, Mode, Settings } from "./types";

export const codeEffortLevels: readonly CodeEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export const codeEffortLabels: Record<CodeEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
  ultra: "Ultracode",
};

export function effortForMode(
  settings: Pick<Settings, "effort" | "codeEffort">,
  mode: Mode,
) {
  return mode === "code" ? settings.codeEffort : settings.effort;
}

/**
 * Stickiness of the current stop while dragging, in stops past the midpoint
 * (2097af56, 1x Windows drag, both directions; the app's change lands one
 * 30fps frame before the first frame that shows the thumb gliding). Ordinary
 * stops change about 2px (0.055 of the 36px spacing) past the midpoint. The
 * Max/Ultracode boundary needs more push: no change with the pointer 23.6px
 * past Max, a change by 27.6px, so it enters at ~25.6px (0.71 of the
 * spacing) and leaves ~4.3px past the midpoint.
 */
export const codeEffortStickiness = { stop: 0.055, enter: 0.21, leave: 0.12 };

/**
 * Stop under a pointer, measured between the thumb centres at either end
 * (8px in from each track end). With `current`, the current stop holds until
 * the pointer passes the stickiness band beyond the midpoint.
 */
export function codeEffortIndexAt(
  clientX: number,
  left: number,
  width: number,
  current?: number,
) {
  const progress = ((clientX - left - 8) / Math.max(1, width - 16)) * 5;
  const index = Math.max(0, Math.min(5, Math.round(progress)));
  const { stop, enter, leave } = codeEffortStickiness;
  if (current !== undefined) {
    const band =
      progress > current
        ? current === 4
          ? enter
          : stop
        : current === 5
          ? leave
          : stop;
    if (Math.abs(progress - current) < 0.5 + band) return current;
  }
  if (index === 5 && current !== 5 && progress < 4.5 + enter) return 4;
  return index;
}

/**
 * Rubber band of the pressed thumb (2097af56): it leans toward the pointer
 * by 4.2·tanh(d / 8px) around its stop, and never past the track ends.
 */
export function codeEffortPull(offset: number, index: number) {
  const pull = 4.2 * Math.tanh(offset / 8);
  if (index === 0) return Math.max(0, pull);
  if (index === 5) return Math.min(0, pull);
  return pull;
}
