import { createContext, useContext } from "react";
import {
  hostFor,
  surface,
  type HostCapability,
  type HostInfo,
} from "../../shared/host";

/**
 * The host the window runs in (shared/host.ts). App provides it (AppScope)
 * from the snapshot, on top of the build surface's default; outside App
 * (sign-in, boot screens) the build surface's default applies.
 */
export const HostContext = createContext<HostInfo>(hostFor(surface));

/**
 * The window's host. Entry points of desktop-only features check their
 * capability here and render nothing when it is off:
 *
 *     if (!useHost().capabilities.popOutWindows) return null;
 */
export function useHost(): HostInfo {
  return useContext(HostContext);
}

/** Whether the window's host has one capability. */
export function useHostCapability(capability: HostCapability): boolean {
  return useContext(HostContext).capabilities[capability] === true;
}
