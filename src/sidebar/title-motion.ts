/*
 * Timing for two small sidebar motions, kept apart from the components so
 * the tests can check them: a conversation's new title writing itself in,
 * and the running dot breathing on one clock with every other dot.
 */

/** The old title fades and blurs out over this long before the new one. */
export const titleOutMs = 200;
/** Each character of the new title fades in this long after the one before. */
export const titleStaggerMs = 30;
/**
 * The new title counts as written once its last character has started and a
 * little more has passed: four characters' worth, as in the original.
 */
export const titleRevealMs = (characters: number) =>
  (characters + 4) * titleStaggerMs;

/**
 * The title's characters as a reader sees them (grapheme clusters), so an
 * emoji or an accented letter fades in whole. Without Intl.Segmenter the
 * code points are used.
 */
export function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** One breath of the running dot (sidebar.css thread-dot-blink). */
export const runningDotMs = 1200;

/**
 * A negative animation-delay that puts a dot's breath on the page's clock:
 * a dot that starts running at `now` begins part-way through, so every
 * running dot in the window rises and falls together, however late it
 * joined (the original syncs its running dots the same way). Computed once,
 * when the dot starts running; recomputing it later would move the phase.
 */
export function sharedPhaseDelay(
  now: number = globalThis.performance?.now() ?? 0,
  period: number = runningDotMs,
) {
  return `${-Math.round(((now % period) + period) % period)}ms`;
}
