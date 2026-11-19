import { hostPowerHistory } from "../../app/host-power";
import type { NativeHost } from "./host";

export const wakeSchedulerStatus = {
  status: "notFound",
  requiresSetup: false,
  approvedThisCycle: false,
  supported: false,
} as const;

export function registerHostPower(host: NativeHost) {
  const snapshot = () => hostPowerHistory.snapshot();
  host.on("WindowState.hostPower_$store$_getState", snapshot);
  host.on("WindowState.hostPower_$store$_getStateSync", snapshot);
  host.on("WakeScheduler.getStatus", () => ({ ...wakeSchedulerStatus }));
  host.on("WakeScheduler.openSettings", () => undefined);
  return hostPowerHistory.subscribe(() => host.emit("WindowState", "hostPower_$store$_update", snapshot()));
}
