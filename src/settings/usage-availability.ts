import type { HostInfo } from "../../shared/host";

/** Service limits, or the existing local Code statistics on this desktop. */
export function usageAvailable(host: HostInfo, planUsage: boolean): boolean {
  return planUsage || (host.kind === "desktop" && host.capabilities.localCode);
}
