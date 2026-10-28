/*
 * The collapsed sidebar's peek, as the original's desktop frame does it: with
 * the sidebar hidden, resting the pointer on the left edge or on the sidebar
 * toggle brings the whole sidebar up as a card over the page, and moving away
 * puts it back. These are the numbers and the pure decisions; useSidebarPeek.ts
 * wires them to the pointer, the keyboard and the timers.
 */

/** Within this many pixels of the window's left edge the pointer opens the peek. */
export const peekOpenPx = 16;
/** Within this many the edge shows its hint strip. */
export const peekHintPx = 48;
/** How long the pointer rests in the opening zone before the peek opens. */
export const peekDwellMs = 100;
/** How long the peek waits after the pointer leaves before it closes. */
export const peekCloseMs = 180;
/** The title bar's height: the edge starts below it (a drag region above). */
export const peekEdgeTop = 48;

export type EdgeZone = "open" | "hint" | "far";

/** Where the pointer is relative to the left edge. */
export function edgeZone(x: number, y: number, height: number): EdgeZone {
  if (y < peekEdgeTop || y >= height) return "far";
  return x <= peekOpenPx ? "open" : x <= peekHintPx ? "hint" : "far";
}

/** The edge's hint strip: none, an 8px strip, or 24px once it will open. */
export type EdgeHint = "none" | "shown" | "snap";

export function edgeHint(zone: EdgeZone, open: boolean): EdgeHint {
  if (open) return "none";
  return zone === "open" ? "snap" : zone === "hint" ? "shown" : "none";
}
