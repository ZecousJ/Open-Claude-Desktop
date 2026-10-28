import { useEffect, useState } from "react";
import type { DispatchStatus } from "../../shared/dispatch-api";
import { api } from "../desktop-api";

export function useRemoteMachines(
  open: boolean,
): (Partial<DispatchStatus> & { failed?: boolean }) | undefined {
  const [status, setStatus] = useState<DispatchStatus>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.dispatchStatus();
        const devices = await Promise.all(
          next.devices.map(async (device) => {
            if (!next.onlineDeviceIds.includes(device.id)) return device;
            try {
              const sessions = (await api.dispatchCall(
                device.id,
                "remoteControlCapacity",
                [],
              )) as { active: number; max: number };
              return { ...device, sessions };
            } catch {
              return device;
            }
          }),
        );
        if (active) {
          setStatus({ ...next, devices });
          setFailed(Boolean(next.machinesFailed));
        }
      } catch {
        if (active) setFailed(true);
      }
      if (active) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open]);
  return status ? { ...status, failed } : failed ? { failed: true } : undefined;
}
