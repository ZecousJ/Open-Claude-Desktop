import type { HostInfo } from "../../shared/host";

/**
 * The web app's sidebar width before the account's setting is known (the first
 * paint, src/boot): the default width, 288px.
 */
export const webSidebarWidth = 288;

/**
 * Classes the window's root element gets from its host. The desktop keeps
 * its platform class (`darwin`, `win32`, `linux`), which the stylesheets use
 * for the traffic lights and window buttons; the web has neither, so it gets
 * `web` instead and no platform class (src/styles/95-web.css).
 */
export function hostClasses(host: HostInfo, platform: string): string {
  return host.kind === "web" ? "web host-web" : `${platform} host-${host.kind}`;
}

/**
 * The sidebar width in px: the setting, or a drag preview of the resize handle.
 * The web follows it too, as claude.ai's web sidebar resizes and the collapse
 * line follows the width; it was fixed at 288 while its handle saved a width
 * nothing used.
 */
export function sidebarWidth(
  _host: HostInfo,
  setting: number,
  preview?: number,
): number {
  return preview ?? setting;
}

/** Whether the window draws its own drag area and, off macOS, its buttons. */
export function windowChrome(host: HostInfo, platform: string) {
  const chrome = host.capabilities.windowChrome;
  return { dragSurface: chrome, controls: chrome && platform !== "darwin" };
}
