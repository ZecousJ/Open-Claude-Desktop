import {
  udidPattern,
  type IosButton,
  type KeyName,
  type SimulatorAppearance,
  type SimulatorDevice,
  type SimulatorDeviceState,
} from "../../shared/simulators";
import { SimulatorError, type InputSpace, type RawElement } from "./driver";
import { CommandError, type Runner } from "./runner";

/** HID keyboard usage codes for the keys typed on the pane that are not characters. */
export const iosKeyCodes: Record<KeyName, number> = {
  ENTER: 40,
  BACKSPACE: 42,
};

// -- Command builders --------------------------------------------------------

export const iosCommands = {
  list: () => ["simctl", "list", "devices", "available", "--json"],
  boot: (udid: string) => ["simctl", "boot", udid],
  /** Returns once the device has finished booting. */
  bootStatus: (udid: string) => ["simctl", "bootstatus", udid],
  shutdown: (udid: string) => ["simctl", "shutdown", udid],
  rename: (udid: string, name: string) => ["simctl", "rename", udid, name],
  /** Writes the PNG to `file` (a private temporary file). */
  screenshot: (udid: string, file: string) => [
    "simctl",
    "io",
    udid,
    "screenshot",
    "--type=png",
    file,
  ],
  install: (udid: string, appPath: string) => [
    "simctl",
    "install",
    udid,
    appPath,
  ],
  launch: (udid: string, bundleId: string) => [
    "simctl",
    "launch",
    udid,
    bundleId,
  ],
  openUrl: (udid: string, url: string) => ["simctl", "openurl", udid, url],
  /** Without a value it prints the current one ("light", "dark", "unsupported"). */
  appearance: (udid: string, set?: SimulatorAppearance) => [
    "simctl",
    "ui",
    udid,
    "appearance",
    ...(set ? [set] : []),
  ],
  pbpaste: (udid: string) => ["simctl", "pbpaste", udid],
  /** Reads the text from standard input. */
  pbcopy: (udid: string) => ["simctl", "pbcopy", udid],
  /** H.264 as the original records; SIGINT finishes the file. */
  recordVideo: (udid: string, file: string) => [
    "simctl",
    "io",
    udid,
    "recordVideo",
    "--codec=h264",
    "--force",
    file,
  ],
};

/** How long a recording may take to start before it counts as running (the original's 400 ms). */
export const recordingSettleMs = 400;

/** idb's `ui` commands; positions are whole points. */
export const idbCommands = {
  describe: (udid: string) => ["describe", "--udid", udid, "--json"],
  /** Every accessibility element on screen, frames in points. */
  describeAll: (udid: string) => [
    "ui",
    "describe-all",
    "--udid",
    udid,
    "--json",
  ],
  tap: (udid: string, x: number, y: number, durationSec?: number) => [
    "ui",
    "tap",
    "--udid",
    udid,
    ...(durationSec && durationSec > 0
      ? ["--duration", String(Math.min(durationSec, 30))]
      : []),
    String(Math.round(x)),
    String(Math.round(y)),
  ],
  swipe: (
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationSec: number,
  ) => [
    "ui",
    "swipe",
    "--udid",
    udid,
    "--duration",
    String(Math.min(Math.max(durationSec, 0.05), 30)),
    String(Math.round(from.x)),
    String(Math.round(from.y)),
    String(Math.round(to.x)),
    String(Math.round(to.y)),
  ],
  // "--" so text that starts with a dash is not read as an option.
  text: (udid: string, value: string) => [
    "ui",
    "text",
    "--udid",
    udid,
    "--",
    value,
  ],
  button: (udid: string, name: IosButton) => [
    "ui",
    "button",
    "--udid",
    udid,
    name,
  ],
  /** A HID keyboard usage code (Return 40, Backspace 42). */
  key: (udid: string, code: number) => [
    "ui",
    "key",
    "--udid",
    udid,
    String(code),
  ],
};

/** Simulator's own shortcuts. */
export function simulatorShortcutScript(code: number, shift = false) {
  return `tell application "System Events"
set previousProcess to first process whose frontmost is true
tell process "Simulator"
set frontmost to true
key code ${code} using {command down${shift ? ", shift down" : ""}}
end tell
set frontmost of previousProcess to true
end tell`;
}

// -- Parsers -----------------------------------------------------------------

const stateOf: Record<string, SimulatorDeviceState | undefined> = {
  Booted: "booted",
  Booting: "booting",
  Shutdown: "shutdown",
  "Shutting Down": "shutting-down",
};

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-0" → "iOS 27.0"; undefined for other platforms. */
export function runtimeName(identifier: string): string | undefined {
  const match = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(identifier);
  return match ? `iOS ${match[1].replace(/-/g, ".")}` : undefined;
}

/**
 * The iOS devices `simctl list devices --json` reports: available ones on
 * an iOS runtime (iPadOS is under it too), booted first, then the newest
 * runtime first and each runtime's devices in simctl's order. Watch, TV and
 * Vision runtimes are left out.
 */
export function parseSimctlDevices(text: string): SimulatorDevice[] {
  let parsed: { devices?: Record<string, unknown> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SimulatorError("simctl answered with something unreadable.");
  }
  const found: (SimulatorDevice & { runtimeOrder: number })[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    const osVersion = runtimeName(runtime);
    if (!osVersion || !Array.isArray(list)) continue;
    const order = osVersion
      .slice(4)
      .split(".")
      .reduce((total, part) => total * 1000 + Number(part), 0);
    for (const item of list) {
      const device = item as Record<string, unknown>;
      const state = stateOf[String(device.state)];
      const udid = String(device.udid ?? "");
      if (
        !state ||
        device.isAvailable === false ||
        !udidPattern.test(udid) ||
        typeof device.name !== "string"
      )
        continue;
      found.push({
        kind: "ios",
        id: udid,
        name: device.name,
        state,
        osVersion,
        runtimeOrder: order,
      });
    }
  }
  const rank = (device: SimulatorDevice) =>
    device.state === "shutdown" ? 1 : 0;
  return found
    .map((device, index) => ({ device, index }))
    .sort(
      (a, b) =>
        rank(a.device) - rank(b.device) ||
        b.device.runtimeOrder - a.device.runtimeOrder ||
        a.index - b.index,
    )
    .map(({ device: { runtimeOrder: _order, ...device } }) => device);
}

/** The device size in points from `idb describe --json`. */
/**
 * `idb ui describe-all --json`: a JSON array of elements (or one object per
 * line), each with `frame` {x, y, width, height} in points, `type`,
 * `AXLabel`, `AXValue`, `AXUniqueId` and `enabled`. The first element is
 * the application; elements later in the list are in front.
 */
export function parseIdbElements(text: string): RawElement[] {
  let items: unknown[] = [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    items = trimmed
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((item) => item !== undefined);
  }
  const str = (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, 500)
      : undefined;
  const out: RawElement[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const element = item as Record<string, unknown>;
    const frame = element.frame as Record<string, unknown> | undefined;
    const numbers = ["x", "y", "width", "height"].map((key) =>
      Number(frame?.[key]),
    );
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    const [x, y, width, height] = numbers;
    if (width <= 0 || height <= 0) continue;
    out.push({
      type: str(element.type) ?? str(element.role_description) ?? "Element",
      label: str(element.AXLabel) ?? str(element.title),
      value: str(element.AXValue),
      identifier: str(element.AXUniqueId),
      frame: { x, y, width, height },
      depth: out.length === 0 ? 0 : 1,
      enabled:
        typeof element.enabled === "boolean" ? element.enabled : undefined,
    });
  }
  return out;
}

export function parseIdbSpace(text: string): InputSpace | undefined {
  try {
    const dimensions = JSON.parse(text)?.screen_dimensions;
    const width = Number(dimensions?.width_points);
    const height = Number(dimensions?.height_points);
    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    )
      return { width, height };
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * Pixels per point of a screenshot whose device measures `space` in points:
 * longer edge over longer edge, so a rotated screen gives the same answer.
 * Undefined unless it comes out as a plausible scale (1x to 4x).
 */
export function pixelRatio(size: InputSpace, space: InputSpace) {
  const ratio =
    Math.max(size.width, size.height) / Math.max(space.width, space.height);
  return Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 4.5
    ? ratio
    : undefined;
}

/** simctl refuses to boot a device that is already booted; that is fine. */
export function alreadyBooted(error: unknown) {
  return (
    error instanceof CommandError && /current state: Booted/i.test(error.stderr)
  );
}

// -- Driver ------------------------------------------------------------------

export interface IosDeps {
  runner: Runner;
  /** Where idb is, or undefined when it isn't installed. */
  findIdb(): Promise<string | undefined>;
  /** Whether a folder exists (an app bundle). */
  isDirectory(path: string): Promise<boolean>;
}

/** The longest a boot may take (a first boot after an update migrates data). */
export const bootTimeoutMs = 180_000;
