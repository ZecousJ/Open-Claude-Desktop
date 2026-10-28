import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const linkIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
let cached: string | undefined;

/**
 * The hardware's own id (the Mac's platform UUID, Windows' MachineGuid,
 * Linux's machine-id), hashed, or undefined when it can't be read.
 */
function machineStamp(): string | undefined {
  let raw: string | undefined;
  try {
    if (process.platform === "darwin")
      raw = /"IOPlatformUUID" = "([^"]+)"/.exec(
        execFileSync(
          "/usr/sbin/ioreg",
          ["-rd1", "-c", "IOPlatformExpertDevice"],
          {
            encoding: "utf8",
            timeout: 3000,
          },
        ),
      )?.[1];
    else if (process.platform === "win32")
      raw = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(
        execFileSync(
          "reg",
          [
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
          ],
          { encoding: "utf8", timeout: 3000, windowsHide: true },
        ),
      )?.[1];
    else
      for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          raw = fs.readFileSync(file, "utf8").trim() || undefined;
        } catch {
          // Try the next place.
        }
        if (raw) break;
      }
  } catch {
    return undefined;
  }
  return raw
    ? createHash("sha256")
        .update(`claudex-device:${raw}`)
        .digest("hex")
        .slice(0, 32)
    : undefined;
}

function made(userData: string, stamp: string | undefined) {
  const id = `pc-${randomUUID().replace(/-/g, "")}`;
  try {
    fs.writeFileSync(path.join(userData, "device-link-id"), id, {
      mode: 0o600,
    });
    if (stamp)
      fs.writeFileSync(path.join(userData, "device-link-machine"), stamp, {
        mode: 0o600,
      });
  } catch {
    // Read-only data folder: the id lasts this run.
  }
  return id;
}

/**
 * This computer's device link id: made once and kept in the app's data
 * folder, so a phone keeps showing the same computer across restarts. It is
 * kept with the hardware it was made on: a data folder copied to another
 * computer gets a new id there, or the two computers would take the link
 * from each other every minute.
 */
export function deviceLinkId(userData: string) {
  if (cached) return cached;
  const stamp = machineStamp();
  let saved: string | undefined;
  let savedStamp: string | undefined;
  try {
    saved = fs
      .readFileSync(path.join(userData, "device-link-id"), "utf8")
      .trim();
  } catch {
    // Not made yet.
  }
  try {
    savedStamp = fs
      .readFileSync(path.join(userData, "device-link-machine"), "utf8")
      .trim();
  } catch {
    // Made before ids were kept with their hardware.
  }
  if (
    saved &&
    linkIdPattern.test(saved) &&
    (!stamp || !savedStamp || savedStamp === stamp)
  ) {
    if (stamp && !savedStamp)
      try {
        fs.writeFileSync(path.join(userData, "device-link-machine"), stamp, {
          mode: 0o600,
        });
      } catch {
        // Kept unstamped.
      }
    return (cached = saved);
  }
  return (cached = made(userData, stamp));
}

/**
 * A new id for this computer, when another computer turns out to link with
 * the same one (a data folder copied before ids were kept with their
 * hardware).
 */
export function renewDeviceLinkId(userData: string) {
  return (cached = made(userData, machineStamp()));
}

/** The name a phone shows: the computer's network name without ".local". */
export function deviceName() {
  const host = os
    .hostname()
    .replace(/\.local$/i, "")
    .trim();
  return host || (process.platform === "darwin" ? "Mac" : "Computer");
}
