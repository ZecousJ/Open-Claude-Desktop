/**
 * The main window's size, position and zoom, remembered across runs in
 * `main-window.json` (geometry and zoom only). The original keeps its main
 * window's position, size, maximized and full-screen state and opens at 1200 x
 * 800 the first time; its minimum is 600 x 400.
 *
 * The file functions and the clamping are plain Node, so they run under the
 * unit tests; `trackMainWindow` only needs the window methods it names.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Rectangle } from "electron";
import { clampToDisplays } from "./chat-windows-support";
import { zoomLimits } from "./window-zoom";

/** The size the main window opens at when nothing is remembered. */
export const defaultMainWindowSize = { width: 1200, height: 800 };
/** The smallest the main window goes. */
export const minMainWindowSize = { width: 600, height: 400 };

const stateSchema = z.object({
  version: z.literal(1),
  bounds: z
    .object({
      width: z.number().int().min(minMainWindowSize.width).max(20000),
      height: z.number().int().min(minMainWindowSize.height).max(20000),
      x: z.number().int().min(-100000).max(100000),
      y: z.number().int().min(-100000).max(100000),
    })
    .optional(),
  maximized: z.boolean().optional(),
  fullScreen: z.boolean().optional(),
  /** Electron's zoom level (0 is 100%), applied to every app window. */
  zoomLevel: z.number().min(zoomLimits.min).max(zoomLimits.max).optional(),
});
export type MainWindowState = z.infer<typeof stateSchema>;

/** Reads the remembered state; anything missing or invalid means "none". */
export function readMainWindowState(
  file: string | undefined,
): MainWindowState | undefined {
  if (!file) return undefined;
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeMainWindowState(file: string, state: MainWindowState) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Where the main window opens: the remembered bounds kept on a display, or
 * the default size (centred by Electron).
 */
export function mainWindowPlacement(
  saved: MainWindowState | undefined,
  workAreas: Rectangle[],
): Partial<Rectangle> & { width: number; height: number } {
  if (!saved?.bounds) {
    const primary = workAreas[0];
    return primary
      ? {
          width: Math.min(defaultMainWindowSize.width, primary.width),
          height: Math.min(defaultMainWindowSize.height, primary.height),
        }
      : { ...defaultMainWindowSize };
  }
  return clampToDisplays(saved.bounds, workAreas);
}

/** The sign-in window: 600 x 600, centred (the original's signed-out window). */
export const signInWindowSize = { width: 600, height: 600 };

/** The window methods the tracker reads. */
export interface TrackedWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getNormalBounds(): Rectangle;
  on(event: string, listener: () => void): unknown;
}

/**
 * Saves the window's geometry (a moment after it stops changing, and when
 * it closes). A maximized or full-screen window is remembered at its normal
 * bounds with the flag set. `zoom` is the level the file keeps beside it.
 */
export function trackMainWindow(
  win: TrackedWindow,
  file: string,
  zoom: () => number | undefined,
  /** False while the window is the small sign-in window: nothing is kept. */
  persist: () => boolean = () => true,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    if (win.isDestroyed() || !persist()) return;
    const frame = win.getNormalBounds();
    const parsed = stateSchema.safeParse({
      version: 1,
      bounds: {
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        width: Math.round(frame.width),
        height: Math.round(frame.height),
      },
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      zoomLevel: zoom(),
    });
    if (!parsed.success) return;
    try {
      writeMainWindowState(file, parsed.data);
    } catch (error) {
      console.error(
        "Window size could not be saved:",
        error instanceof Error ? error.message : error,
      );
    }
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  for (const event of [
    "resize",
    "move",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ])
    win.on(event, later);
  // Hiding (the close button) and quitting both leave the latest state.
  win.on("hide", () => {
    if (timer) clearTimeout(timer);
    save();
  });
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

/** Writes the zoom level into the remembered state, keeping the rest. */
export function rememberZoomLevel(file: string, zoomLevel: number) {
  const current = readMainWindowState(file) ?? { version: 1 as const };
  try {
    writeMainWindowState(file, { ...current, zoomLevel });
  } catch (error) {
    console.error(
      "Zoom level could not be saved:",
      error instanceof Error ? error.message : error,
    );
  }
}
