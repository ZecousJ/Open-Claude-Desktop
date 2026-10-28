import { useLayoutEffect, useState, type RefObject } from "react";
import type { ComposerField } from "./composer-field";

/** Between the text and the controls on either side of it. */
const controlGap = 8;
/** Room kept free on a single line before the text moves to its own row. */
export const singleLineReserve = 24;

/**
 * Whether a draft needs the two-row composer: a line break, or a line wider
 * than the single row leaves for text (less `singleLineReserve`), so the
 * row turns before the text would wrap under the actions. The same test runs
 * both ways, against the single row's room, so the composer goes back to one
 * row once the text fits again.
 */
export function needsTwoRows(
  text: string,
  textWidth: number,
  singleRowRoom: number,
): boolean {
  if (!text) return false;
  if (text.includes("\n")) return true;
  return textWidth > singleRowRoom - singleLineReserve;
}

let canvas: HTMLCanvasElement | undefined;
/** The width `text` takes on one line in the textarea's font. */
function lineWidth(field: HTMLElement, text: string) {
  canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return 0;
  const style = getComputedStyle(field);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return context.measureText(text).width;
}

/**
 * The conversation composer's single row and its two-row form: on one row the
 * text sits between the leading controls and the actions; once it needs more
 * room the text takes the whole width and the controls keep to a row under it.
 * The controls' widths are written to the row as --composer-lead-w and
 * --composer-trail-w for its padding; the returned flag is the two-row form.
 */
export function useComposerMorph(
  enabled: boolean,
  row: RefObject<HTMLElement | null>,
  lead: RefObject<HTMLElement | null>,
  trail: RefObject<HTMLElement | null>,
  field: RefObject<ComposerField | null>,
  text: string,
): boolean {
  const [twoRows, setTwoRows] = useState(false);
  const [room, setRoom] = useState(0);
  // The controls' widths, kept on the row and followed as they change.
  useLayoutEffect(() => {
    const box = row.current;
    if (!enabled || !box) return;
    const measure = () => {
      const leadWidth = lead.current?.offsetWidth ?? 0;
      const trailWidth = trail.current?.offsetWidth ?? 0;
      const leadSpace = leadWidth ? leadWidth + controlGap : 0;
      const trailSpace = trailWidth ? trailWidth + controlGap : 0;
      box.style.setProperty("--composer-lead-w", `${leadSpace}px`);
      box.style.setProperty("--composer-trail-w", `${trailSpace}px`);
      setRoom(Math.max(0, box.clientWidth - leadSpace - trailSpace));
    };
    // Reading the actions first commits the row's fallback padding. Do not
    // animate from that provisional value on the first measurement. The
    // clientWidth read inside measure commits the measured padding before
    // the original transition (and its priority) is restored.
    const transition = box.style.getPropertyValue("transition");
    const priority = box.style.getPropertyPriority?.("transition") ?? "";
    box.style.setProperty("transition", "none", priority);
    measure();
    if (transition) box.style.setProperty("transition", transition, priority);
    else box.style.removeProperty("transition");
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (lead.current) observer.observe(lead.current);
    if (trail.current) observer.observe(trail.current);
    return () => observer.disconnect();
  }, [enabled]);
  useLayoutEffect(() => {
    const area = field.current;
    if (!enabled || !area || !room) return setTwoRows(false);
    setTwoRows(needsTwoRows(text, lineWidth(area, text), room));
  }, [enabled, text, room]);
  // The text area's height follows its text as its width changes with the
  // row's padding (the draft's own autosize runs only when the text does).
  useLayoutEffect(() => {
    const area = field.current;
    if (!enabled || !area || area.resizeToContent) return;
    let width = area.clientWidth;
    const observer = new ResizeObserver(() => {
      if (!area.isConnected) {
        observer.disconnect();
        return;
      }
      if (area.clientWidth === width) return;
      width = area.clientWidth;
      // Measured at height 0 (see useComposerAutosize), and never past the
      // Code/Chat caps when the sheet sets no max-height.
      const styleMax = parseFloat(getComputedStyle(area).maxHeight);
      const max = Number.isFinite(styleMax) ? styleMax : 380;
      area.style.height = "0px";
      area.style.height = `${Math.min(area.scrollHeight, max)}px`;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [enabled]);
  return enabled && twoRows;
}
