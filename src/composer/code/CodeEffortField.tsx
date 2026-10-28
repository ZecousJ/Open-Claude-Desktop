import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  createTwinkle,
  exponentialEasing,
  fieldBase,
  fieldCell,
  fieldCells,
  fieldColor,
  frontJitter,
  frontJitterMs,
  frontReach,
  frontTiming,
  profileAt,
  twinkleOffsets,
  twinkleTick,
} from "./code-effort-field";

// Measured Ultracode front: starts ~290ms after the change, then slows with a
// ~1s time constant; see code-effort-field.ts.
const frontEase = exponentialEasing(3600, 1000);

/**
 * The Ultracode point field: a canvas of twinkling cells, dimmed along the
 * track by the measured profile and revealed by the CSS front mask. It keeps
 * twinkling while it fades out after Ultracode is left (2097af56: cells
 * still jump until the fade ends).
 */
export function CodeEffortField({
  active,
  width,
}: {
  active: boolean;
  width: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [leaving, setLeaving] = useState(false);
  const wasActive = useRef(active);
  const clockRef = useRef<Animation | null>(null);
  /** Clock time Ultracode was chosen; null while it is not (no dithering). */
  const activatedAt = useRef<number | null>(null);
  useEffect(() => {
    if (wasActive.current && !active) setLeaving(true);
    if (active) setLeaving(false);
    // Opened already on Ultracode: the field shows at once, as before.
    activatedAt.current =
      active && !wasActive.current
        ? Number(clockRef.current?.currentTime ?? 0)
        : null;
    wasActive.current = active;
  }, [active]);
  const running = active || leaving;
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const trackWidth = element.parentElement?.parentElement?.clientWidth || 196;
    const scale = window.devicePixelRatio || 1;
    element.width = Math.round(trackWidth * scale);
    element.height = Math.round(20 * scale);
    element.style.width = `${trackWidth}px`;
    const cells = fieldCells(trackWidth, 7);
    const palettes = cells.map(({ x, base }) =>
      twinkleOffsets.map((offset) =>
        fieldColor(fieldBase[base][1], offset, profileAt(x + fieldCell / 2)),
      ),
    );
    const levels = createTwinkle(cells.length, 29);
    const jitter = frontJitter(cells.length, 43);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Cells snap to device pixels so they stay crisp at 1x as well as 2x
    // (at 1x the 0.5px row inset becomes 1px: 2097af56 lights rows 1-3).
    const size = Math.round(fieldCell * scale);
    const draw = (tick: number, time = 0) => {
      const level = levels(tick);
      context.clearRect(0, 0, element.width, element.height);
      // The dithered leading edge: while the front sweeps in, each cell it
      // reaches waits a random 0-60ms more before it lights.
      const since =
        reduced || activatedAt.current === null
          ? Infinity
          : time - activatedAt.current;
      const fieldWidth = element.parentElement?.clientWidth || trackWidth;
      cells.forEach(({ x, y }, i) => {
        if (
          since < frontReach(x + fieldCell / 2, fieldWidth) + jitter[i] &&
          since < frontTiming.delay + frontTiming.duration + frontJitterMs
        )
          return;
        context.fillStyle = palettes[i][level[i]];
        context.fillRect(
          Math.round(x * scale),
          Math.round(y * scale + 0.01),
          size,
          size,
        );
      });
    };
    draw(0);
    if (!running || reduced) return;
    // A Web Animation as the clock, so frame captures that pause and seek
    // document animations also freeze and seek the twinkle.
    // Infinite iterations keep its currentTime growing past one duration.
    const clock = element.animate([], {
      duration: 60_000,
      iterations: Infinity,
    });
    clockRef.current = clock;
    let frame = 0;
    let last = 0;
    const loop = () => {
      const time = Number(clock.currentTime ?? 0);
      const tick = Math.floor(time / twinkleTick);
      if (tick !== last) draw((last = tick), time);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      clock.cancel();
      clockRef.current = null;
    };
  }, [running]);
  return (
    <span
      className="code-effort-ultra-grid"
      data-active={active}
      style={{ width, "--code-effort-front-ease": frontEase } as CSSProperties}
      onTransitionEnd={(event) => {
        if (event.propertyName === "opacity" && !active) setLeaving(false);
      }}
    >
      <canvas ref={canvas} aria-hidden="true" />
    </span>
  );
}
