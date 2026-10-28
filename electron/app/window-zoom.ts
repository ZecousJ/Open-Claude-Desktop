/**
 * Page zoom for the app windows (View ▸ Zoom In, Zoom Out, Actual Size). The
 * original zooms every window together in half steps, keeps the level across
 * runs, and moves the macOS traffic lights with the zoom so they stay centred
 * on the title bar (the button position is `round((base + 6) *
 * zoomFactor - 6)`).
 */

/** The step of Zoom In and Zoom Out, in Electron zoom levels. */
export const zoomStep = 0.5;
/** The factor is kept between 25% and 500%, which is these levels. */
export const zoomLimits = {
  min: Math.log(0.25) / Math.log(1.2),
  max: Math.log(5) / Math.log(1.2),
};

/** The level after a step, kept to half steps within the limits. */
export function steppedZoomLevel(level: number, delta: number) {
  const next = Math.round((level + delta) / zoomStep) * zoomStep;
  return Math.min(zoomLimits.max, Math.max(zoomLimits.min, next));
}

/** The factor Chromium uses for a zoom level. */
export const zoomFactorOf = (level: number) => Math.pow(1.2, level);

/**
 * Traffic light positions at 100%, before rounding: the original's are 33/2 on
 * both axes, which lands on (17, 17). With the original's 74px light spacer the
 * sidebar's controls start at x 84, as Claudex's do.
 */
export const baseTrafficLights = { x: 33 / 2, y: 33 / 2 };
const halfButton = 6;

/** Where the traffic lights sit at a zoom level. */
export function trafficLightPosition(level: number) {
  const factor = zoomFactorOf(level);
  const scale = (value: number) =>
    Math.max(0, Math.round((value + halfButton) * factor - halfButton));
  return { x: scale(baseTrafficLights.x), y: scale(baseTrafficLights.y) };
}

/** The window methods zoom touches (`BrowserWindow`'s, narrowed for tests). */
export interface ZoomableWindow {
  isDestroyed(): boolean;
  setWindowButtonPosition?(position: { x: number; y: number } | null): void;
  webContents: {
    isDestroyed(): boolean;
    setZoomLevel(level: number): void;
  };
}

/** Applies a zoom level to one window and moves its traffic lights. */
export function applyZoom(win: ZoomableWindow, level: number) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.setZoomLevel(level);
  win.setWindowButtonPosition?.(trafficLightPosition(level));
}
