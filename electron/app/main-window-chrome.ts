import { initialCaptionOverlay } from "./caption-overlay";
import { trafficLightPosition } from "./window-zoom";

/** Official desktop 2.37337.1 main window: hidden titlebar, overlay disabled,
 * explicit zoom-aware native button origin (index.chunk:283422–283424).
 * Windows keeps the existing system caption overlay for real OS hit testing. */
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
