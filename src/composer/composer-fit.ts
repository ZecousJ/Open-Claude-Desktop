import type { ComposerField } from "./composer-field";

const watched = new WeakSet<HTMLElement>();

/**
 * Keeps a draft box as tall as its text when its width changes: the box
 * narrowing (a side panel opening) or widening, and a textarea mounted
 * afresh when the layout around it switches, which has no height of its own
 * yet. The original's editor wraps by itself; the textarea needs measuring.
 * The cap is the stylesheet's max-height (Code and Chat differ). Call it
 * with the field from its ref; a field is watched once.
 */
export function watchComposerWidth(field: ComposerField | null) {
  if (!field || watched.has(field) || typeof ResizeObserver === "undefined")
    return;
  watched.add(field);
  let width = -1;
  const observer = new ResizeObserver(() => {
    if (!field.isConnected) {
      observer.disconnect();
      return;
    }
    // The rich Chat field lays itself out; height changes here are ours.
    if (field.resizeToContent || field.clientWidth === width) return;
    width = field.clientWidth;
    const max = parseFloat(getComputedStyle(field).maxHeight);
    field.style.height = "auto";
    field.style.height = `${Number.isFinite(max) ? Math.min(field.scrollHeight, max) : field.scrollHeight}px`;
  });
  observer.observe(field);
}
