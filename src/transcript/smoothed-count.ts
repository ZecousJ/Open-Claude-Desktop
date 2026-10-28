import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../ui/usePresence";

/** A first count rises from zero over this long. */
const firstRiseMs = 1200;
/** Later rises take as long as the last update took, within these bounds. */
const shortestRiseMs = 300;
const longestRiseMs = 3000;
/** How often the shown count moves. */
const tickMs = 100;

/**
 * A count that climbs to each new value instead of jumping: it runs straight
 * from what it shows toward the new value over the time the last update took,
 * so steady updates read as a steady climb; a smaller value is taken at once.
 */
export function countSmoother() {
  let target: number | undefined;
  let from = 0;
  let startedAt = 0;
  let duration = 0;
  let updatedAt: number | undefined;
  const valueAt = (now: number) => {
    if (target === undefined) return undefined;
    if (duration <= 0) return target;
    const progress = Math.min(1, (now - startedAt) / duration);
    return Math.floor(from + (target - from) * progress);
  };
  return {
    valueAt,
    snapTo(value: number, now: number) {
      target = value;
      from = value;
      duration = 0;
      updatedAt = now;
    },
    update(value: number | undefined, now: number) {
      if (value === undefined) {
        target = undefined;
        duration = 0;
        updatedAt = undefined;
        return;
      }
      if (value === target) return;
      if (target === undefined) {
        from = 0;
        startedAt = now;
        duration = firstRiseMs;
        target = value;
        updatedAt = now;
        return;
      }
      if (value < target) {
        target = value;
        duration = 0;
        updatedAt = now;
        return;
      }
      const since = updatedAt === undefined ? longestRiseMs : now - updatedAt;
      from = valueAt(now) ?? value;
      startedAt = now;
      duration = Math.min(longestRiseMs, Math.max(shortestRiseMs, since));
      target = value;
      updatedAt = now;
    },
  };
}

/**
 * The count to show for `value`, climbing toward it every 100ms. `key` names
 * whose count it is (a new turn starts from its own value, not a climb).
 */
export function useSmoothedCount(value: number, key: string) {
  const moving = value > 0 && !prefersReducedMotion();
  const [shown, setShown] = useState<{ key: string; value: number } | null>(
    null,
  );
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!moving) return;
    const smoother = countSmoother();
    smoother.snapTo(latest.current, performance.now());
    const timer = window.setInterval(() => {
      const target = latest.current;
      const now = performance.now();
      smoother.update(target > 0 ? target : undefined, now);
      const next = smoother.valueAt(now) ?? target;
      setShown((current) =>
        current?.key === key && current.value === next
          ? current
          : { key, value: next },
      );
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [moving, key]);
  return moving && shown?.key === key ? shown.value : value;
}
