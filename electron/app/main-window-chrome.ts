import { initialCaptionOverlay } from "./caption-overlay";
import { trafficLightPosition } from "./window-zoom";

/**
 * The main window: hidden titlebar, overlay disabled,
 * explicit zoom-aware native button origin. Windows keeps the existing system
 * caption overlay for real OS hit testing.
 */
export function mainWindowChrome(
  platform: NodeJS.Platform,
  zoomLevel: number,
  dark: boolean,
) {
  return {
    titleBarStyle: "hidden" as const,
    titleBarOverlay: platform === "win32" ? initialCaptionOverlay(dark) : false,
    ...(platform === "darwin"
      ? { trafficLightPosition: trafficLightPosition(zoomLevel) }
      : {}),
  };
}
