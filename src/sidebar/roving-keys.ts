import type { KeyboardEvent } from "react";

/**
 * Where a vertical or horizontal arrow, Home or End moves among `count` stops
 * from `index`, or undefined for any other key. The vertical arrows loop round
 * the ends, as the original's sidebar does; the horizontal ones stop at the
 * ends of a row's controls.
 */
export function rovingStep(
  key: string,
  index: number,
  count: number,
  axis: "vertical" | "horizontal",
): number | undefined {
  if (count === 0) return undefined;
  if (axis === "vertical") {
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowDown") return (index + 1) % count;
    if (key === "ArrowUp") return (index - 1 + count) % count;
    return undefined;
  }
  if (key === "ArrowRight") return Math.min(index + 1, count - 1);
  if (key === "ArrowLeft") return Math.max(index - 1, 0);
  return undefined;
}

const items = "[data-roving-item]";
const hidden = '[inert],[hidden],[aria-hidden="true"]';

/** Left out of the walk: inside something hidden or inert, or not drawn. */
const unreachable = (element: HTMLElement) =>
  element.closest(hidden) !== null || element.getClientRects().length === 0;

/** The item that last had focus in each block of the list. */
export type Stops = Map<HTMLElement, HTMLElement>;

/**
 * Each block's one Tab stop takes tabindex 0 and the others -1: the item that
 * last had focus, else the selected row, else the first.
 */
export function applyStops(root: HTMLElement, stops: Stops) {
  for (const block of root.querySelectorAll<HTMLElement>(
    "[data-roving-block]",
  )) {
    const all = [...block.querySelectorAll<HTMLElement>(items)].filter(
      (element) => element.closest(hidden) === null,
    );
    const remembered = stops.get(block);
    const stop =
      (remembered && all.includes(remembered) ? remembered : undefined) ??
      all.find((element) => element.closest(".selected")) ??
      all[0];
    for (const element of all) element.tabIndex = element === stop ? 0 : -1;
  }
}

/** Focus landed on an item: it becomes its block's Tab stop. */
export function rememberStop(stops: Stops, target: EventTarget) {
  if (!(target instanceof HTMLElement) || !target.matches(items)) return;
  const block = target.closest<HTMLElement>("[data-roving-block]");
  if (!block) return;
  stops.set(block, target);
  for (const element of block.querySelectorAll<HTMLElement>(items))
    element.tabIndex = element === target ? 0 : -1;
}

/** ↓ ↑ Home End walk the items; ← → walk the controls of one row. */
export function handleKey(root: HTMLElement, event: KeyboardEvent) {
  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    // A menu or dialog opened from a row bubbles through React, not the DOM.
    !root.contains(target) ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    target.closest("input,textarea,select,[contenteditable]")
  )
    return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const row = target.closest<HTMLElement>("[data-roving-row]");
    if (!row) return;
    const controls = [
      ...row.querySelectorAll<HTMLElement>("button:not(:disabled)"),
    ].filter((element) => !unreachable(element));
    const at = controls.indexOf(target);
    const next = rovingStep(event.key, at, controls.length, "horizontal");
    if (next === undefined || at < 0) return;
    event.preventDefault();
    controls[next]?.focus();
    return;
  }
  const all = [...root.querySelectorAll<HTMLElement>(items)].filter(
    (element) => !unreachable(element),
  );
  // A control that is not an item (a row's ⋮) walks from its row's item.
  const from = target.matches(items)
    ? target
    : target
        .closest<HTMLElement>("[data-roving-row]")
        ?.querySelector<HTMLElement>(items);
  const index = from ? all.indexOf(from) : -1;
  if (index < 0) return;
  const next = rovingStep(event.key, index, all.length, "vertical");
  if (next === undefined) return;
  event.preventDefault();
  all[next]?.focus();
  all[next]?.scrollIntoView({ block: "nearest" });
}
