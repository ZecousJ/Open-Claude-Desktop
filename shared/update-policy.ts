import { validClaudexVersion, validDeviceId } from "./claudex-contract";

export interface UpdatePolicy {
  disableAutoUpdates?: boolean;
  enforcementHours?: number;
  uncleanExitInstallWindowMinutes: number;
  maxVersion?: string;
  channelUuid?: string;
  updatesHost?: string;
  squirrelFeedUrl?: string;
}

export interface UpdateDevice {
  deviceId: string;
  version: string;
  osVersion: string;
  maxVersion?: string;
  channelUuid?: string;
}

// .
export function updateDeviceQuery(device: UpdateDevice) {
  const query = new URLSearchParams({
    device_id: device.deviceId,
    version: device.version,
    os_version: device.osVersion,
  });
  if (device.maxVersion) query.set("maxVersion", device.maxVersion);
  if (device.channelUuid) query.set("channelUuid", device.channelUuid);
  return query;
}

export function parseUpdatePolicy(value: unknown): UpdatePolicy {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const hours = source.enforcementHours;
  const minutes = source.uncleanExitInstallWindowMinutes;
  const policy: UpdatePolicy = {
    ...(source.disableAutoUpdates === true ? { disableAutoUpdates: true } : {}),
    uncleanExitInstallWindowMinutes:
      minutes === undefined
        ? 30
        : typeof minutes === "number" &&
            Number.isFinite(minutes) &&
            minutes >= 0
          ? Math.min(minutes, 120)
          : 0,
  };
  if (
    typeof hours === "number" &&
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= 72
  )
    policy.enforcementHours = hours;
  for (const key of [
    "maxVersion",
    "channelUuid",
    "updatesHost",
    "squirrelFeedUrl",
  ] as const)
    if (typeof source[key] === "string" && source[key])
      policy[key] = source[key];
  if (!validClaudexVersion(policy.maxVersion)) delete policy.maxVersion;
  if (!validDeviceId(policy.channelUuid)) delete policy.channelUuid;
  for (const key of ["updatesHost", "squirrelFeedUrl"] as const) {
    try {
      const url = new URL(policy[key] ?? "");
      if (url.protocol !== "https:" || url.username || url.password)
        delete policy[key];
    } catch {
      delete policy[key];
    }
  }
  return policy;
}

export interface DesktopUpdaterConfig {
  check_interval_ticks?: number;
  staged_peek_min_interval_minutes?: number;
}

// .
export function updaterIntervals(config?: DesktopUpdaterConfig) {
  const ticks = config?.check_interval_ticks;
  const minutes = config?.staged_peek_min_interval_minutes;
  return {
    check:
      (typeof ticks === "number" &&
      Number.isInteger(ticks) &&
      ticks >= 1 &&
      ticks < 4
        ? ticks
        : 4) *
      60 *
      60_000,
    peek:
      (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? Math.min(minutes, 120)
        : 120) * 60_000,
  };
}
