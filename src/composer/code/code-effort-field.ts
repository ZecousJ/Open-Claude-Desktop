/**
 * Ultracode point field for the Code effort slider. Geometry and base colours
 * come from R-0330-0361 (Extra -> Ultracode, 30fps) and R-0361 (steady
 * state); the twinkle statistics from the Windows drag recording 2097af56
 * (1x, frames 300-408). Pure helpers so the pattern and timing stay testable
 * without a DOM; `CodeEffortField.tsx` draws them on a canvas.
 */

/** Cell size and pitch in CSS px: 3px squares on a 4px grid, five rows. */
export const fieldCell = 3;
export const fieldPitch = 4;
export const fieldRows = 5;

/** Deterministic LCG, so every render draws the same field. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Base cell colours: R-0330 frames 90-180 (per-cell 25th percentile,
 * un-mapped from the video tone curve) cross-checked with R-0361 (which is
 * uniformly dimmed to ~0.865). Cumulative [limit, fill] pairs: a roll below
 * the first limit takes the first fill, and so on.
 */
export const fieldBase = [
  [0.45, "#63557e"],
  [0.8, "#6f608b"],
  [0.92, "#796895"],
  [1, "#8a77a1"],
] as const;

/**
 * Cells of a track `width` px wide. The lattice is anchored to the track's
 * right end: cell centres sit 3.5px + 4k in from it, which gives x = 4k + 3 on
 * the 196px macOS track and 4k + 1.1 on the 197.6px Windows one (2097af56).
 * Each cell gets a base colour index into `fieldBase`.
 */
export function fieldCells(width: number, seed: number) {
  const random = seededRandom(seed);
  const cells: { x: number; y: number; base: number }[] = [];
  for (let x = width - 5; x >= 0; x -= fieldPitch)
    for (let row = 0; row < fieldRows; row++) {
      const roll = random();
      const base = fieldBase.findIndex(([limit]) => roll < limit);
      cells.push({ x, y: row * fieldPitch + 0.5, base });
    }
  return cells;
}

/**
 * Twinkle levels, as luma offsets from the cell's base in the fully lit part
 * of the field (2097af56: cell-centre pixels 130-168px along the track,
 * relative to each cell's median, 108 frames; p1/p5/p95/p99 at −21/−18/+21/
 * +35). Cells step between these levels without fading.
 */
export const twinkleOffsets = [-20, -10, 0, 10, 21, 35] as const;
/** Share of time spent at each level in the reference. */
export const twinkleShares = [0.053, 0.122, 0.591, 0.057, 0.163, 0.015];
/** Median hold per level in 30fps frames; peaks are brief, base holds long. */
export const twinkleHolds = [9, 12, 13, 7, 4.5, 2] as const;
/** Log-normal spread of the holds. */
export const twinkleSpread = 0.5;
/** The reference steps on its 30fps frames. */
export const twinkleTick = 1000 / 30;
/**
 * Measured level transitions (row: from, column: to). A peak falls back to
 * the +18 half level, which then returns to base; dimmed cells often flash
 * straight up.
 */
export const twinkleNext = [
  [0, 0.02, 0.33, 0.21, 0.44, 0],
  [0, 0, 0.37, 0.11, 0.43, 0.09],
  [0.17, 0.18, 0, 0.05, 0.47, 0.13],
  [0, 0.21, 0.6, 0, 0.14, 0.05],
  [0, 0, 0.92, 0.07, 0, 0.01],
  [0, 0, 0, 0.1, 0.9, 0],
] as const;

function pick(shares: readonly number[], roll: number) {
  const total = shares.reduce((sum, share) => sum + share, 0);
  let limit = 0;
  for (let i = 0; i < shares.length; i++) {
    limit += shares[i] / total;
    if (roll < limit) return i;
  }
  return shares.length - 1;
}

/**
 * Stepped random walk of `count` cells. The returned function gives each
 * cell's level index (into `twinkleOffsets`) at a 30fps tick; it runs
 * forward from its last tick and replays from the seed when asked for an
 * earlier one, so the field is a pure function of time.
 */
export function createTwinkle(count: number, seed: number) {
  const level = new Uint8Array(count);
  const until = new Int32Array(count);
  let random = seededRandom(seed);
  let tick = 0;
  const hold = (index: number) => {
    // Box-Muller normal from two uniform rolls.
    const normal =
      Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const frames = twinkleHolds[index] * Math.exp(twinkleSpread * normal);
    return Math.max(1, Math.min(30, Math.round(frames)));
  };
  const reset = () => {
    random = seededRandom(seed);
    tick = 0;
    for (let i = 0; i < count; i++) {
      level[i] = pick(twinkleShares, random());
      until[i] = Math.ceil(random() * hold(level[i]));
    }
  };
  reset();
  return (target: number) => {
    if (target < tick) reset();
    while (tick < target) {
      tick++;
      for (let i = 0; i < count; i++)
        if (until[i] <= tick) {
          level[i] = pick(twinkleNext[level[i]], random());
          until[i] = tick + hold(level[i]);
        }
    }
    return level;
  };
}

/**
 * Steady brightness profile along the track (2097af56 frames 340-400, B−G
 * per 8px bin normalised at 172px): [x in px from the track start, opacity].
 * It rises all the way to the thumb, with no falloff beside it.
 */
export const fieldProfile = [
  [30, 0],
  [36, 0.02],
  [44, 0.059],
  [52, 0.086],
  [60, 0.137],
  [68, 0.188],
  [76, 0.282],
  [84, 0.306],
  [92, 0.388],
  [100, 0.451],
  [108, 0.553],
  [116, 0.659],
  [124, 0.741],
  [132, 0.8],
  [140, 0.851],
  [148, 0.871],
  [156, 0.929],
  [164, 0.976],
  [172, 1],
] as const;

/** Profile opacity at `x` px from the track start. */
export function profileAt(x: number) {
  const i = fieldProfile.findIndex(([at]) => at > x);
  if (i === 0) return 0;
  if (i < 0) return 1;
  const [x0, a0] = fieldProfile[i - 1];
  const [x1, a1] = fieldProfile[i];
  return a0 + ((a1 - a0) * (x - x0)) / (x1 - x0);
}

/** The bare track (#363636) under the field. */
export const fieldTrack = 0x36;

/**
 * Fill of a cell with a `base` colour stepped by a luma `offset`, where the
 * profile opacity is `profile`. The base and the dimmed levels fade with the
 * profile, the flashes much less: in the dim tail (60-110px, opacity ~0.3)
 * the reference's flashes keep ~0.6-0.8 of their lit-part size while its
 * dark steps almost vanish. So the cell is drawn at opacity profile^0.4,
 * with its base and dark steps pre-dimmed. Channels step almost evenly,
 * slightly more in blue (#5f5279 → #695c82 → #7c7091 → #9489b1), and a cell
 * never goes darker than the bare track.
 */
export function fieldColor(base: string, offset: number, profile: number) {
  if (profile <= 0) return "transparent";
  const alpha = profile ** 0.4;
  const value = parseInt(base.slice(1), 16);
  const step = offset < 0 ? (offset * profile) / alpha : offset;
  const channel = (shift: number, weight: number) => {
    const dimmed =
      fieldTrack + ((((value >> shift) & 255) - fieldTrack) * profile) / alpha;
    return Math.max(
      fieldTrack,
      Math.min(255, Math.round(dimmed + step * weight)),
    );
  };
  const rgb = [channel(16, 0.95), channel(8, 1), channel(0, 1.05)];
  return `rgb(${rgb.join(" ")} / ${alpha.toFixed(3)})`;
}

/**
 * CSS `linear()` easing for an exponential approach 1 - e^(-t/tau) over
 * `duration`, normalised to reach exactly 1. The reference front slows with a
 * time constant of ~1s, and the thumb glides to a new stop with τ ≈ 35ms.
 */
export { exponentialEasing } from "../../ui/exponential-easing";

/**
 * The front's timing, as the CSS mask in code-effort-slider.css runs it: it
 * waits `delay` ms, then moves for `duration` ms on an exponential approach
 * with time constant `tau`. The transparent side of its 24px soft edge
 * starts at the field's right end and stops 18px from the track start.
 */
export const frontTiming = { delay: 290, duration: 3600, tau: 1000 };
/** Latest extra onset of a cell the front reaches (the dithered leading edge). */
export const frontJitterMs = 60;

/**
 * When the front's soft edge first reaches a cell centred at `x` in a field
 * `width` px wide, in ms after Ultracode was chosen; Infinity for a cell
 * the front never reaches.
 */
export function frontReach(x: number, width: number) {
  const { delay, duration, tau } = frontTiming;
  const travel = width - 18;
  if (travel <= 0) return delay;
  // The cell starts to show once the edge's transparent side passes it.
  const share = (width - x) / travel;
  if (share <= 0) return delay;
  if (share > 1) return Infinity;
  const end = 1 - Math.exp(-duration / tau);
  return delay - tau * Math.log(1 - share * end);
}

/**
 * A fixed random extra onset (0 to `frontJitterMs`) per cell, so the cells
 * at the front light up one by one instead of along a straight line; cells
 * behind the front are not affected.
 */
export function frontJitter(count: number, seed: number) {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => random() * frontJitterMs);
}
