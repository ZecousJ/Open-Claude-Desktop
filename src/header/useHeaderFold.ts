import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { foldCount } from "./code-panes";

/** The original's least title width before buttons fold (Rt = 100). */
const titleFloor = 100;
/** A button and its gap before the bar has one to measure (Bt = 32). */
const defaultSlot = 32;

/**
 * How many of the Code header's buttons fold into View options (the
 * original's titlebar measure, simplified): the bar's width against what
 * its parts need with every button shown and the title at its least
 * (100px, or its own width when shorter). Measured on every resize of the
 * bar and whenever `key` (the title, the set of buttons) changes.
 */
export function useHeaderFold(
  bar: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** The buttons that can fold: the rail toggle and the panes. */
  total: number,
  max: number,
  key: string,
  /** View options shows only once something folds (the web): folding
   * then also makes room for it. */
  overflowOnFold = false,
) {
  const [hidden, setHidden] = useState(0);
  // The fold as last set: a new measure (another key) starts from it, so it
  // can unfold what the previous one folded.
  const shown = useRef(0);
  shown.current = hidden;
  useLayoutEffect(() => {
    const root = bar.current;
    if (!enabled || !root) {
      setHidden(0);
      return;
    }
    let current = shown.current;
    const measure = () => {
      // What folds now is read from the bar itself, so a measure after the
      // fold changed gives the same answer.
      const lead = root.firstElementChild as HTMLElement | null;
      const actions = root.querySelector<HTMLElement>(".header-actions");
      const title = root.querySelector<HTMLElement>(".thread-title > span");
      if (!lead || !actions || root.clientWidth === 0) return;
      const style = getComputedStyle(root);
      const available =
        root.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      const gap = parseFloat(style.columnGap) || 0;
      const sample = actions.querySelector<HTMLElement>(".panel-toggle");
      const slot = sample
        ? sample.offsetWidth +
          (parseFloat(getComputedStyle(actions).columnGap) || 0)
        : defaultSlot;
      const titleNatural = title?.scrollWidth ?? 0;
      const titleShown = title?.clientWidth ?? 0;
      const leadLeast =
        lead.getBoundingClientRect().width -
        titleShown +
        Math.min(titleNatural, titleFloor);
      const gapOfActions = parseFloat(getComputedStyle(actions).columnGap) || 0;
      const folded = Math.max(
        0,
        total - actions.querySelectorAll(".panel-toggle").length,
      );
      // The rule after the rail toggle goes with it.
      const rule = actions.querySelector(".panel-toggle-rule")
        ? 0
        : folded > 0
          ? 1 + gapOfActions
          : 0;
      const actionsFull =
        actions.getBoundingClientRect().width + folded * slot + rule;
      const needed = leadLeast + gap + actionsFull;
      const limit = Math.min(max, total);
      let next = foldCount({ available, needed, slot, max: limit });
      if (
        overflowOnFold &&
        next > 0 &&
        !actions.querySelector(".conversation-more")
      )
        next = foldCount({
          available,
          needed: needed + slot,
          slot,
          max: limit,
        });
      if (next !== current) {
        current = next;
        setHidden(next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [bar, enabled, total, max, key, overflowOnFold]);
  return hidden;
}
