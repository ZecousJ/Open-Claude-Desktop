import {
  androidSetupReady,
  iosSetupReady,
  simulatorSupported,
  type AndroidSetupStatus,
  type IosSetupStatus,
  type SimulatorDevice,
  type SimulatorInput,
  type SimulatorKind,
  type SimulatorOpenTarget,
} from "../../shared/simulators";

/** The Settings preference that gives Claude each kind's tools. */
export const accessPreference = {
  ios: "iosSimulatorAccess",
  android: "androidEmulatorAccess",
} as const;

/** The panel id each kind opens in the tool dock. */
export const simulatorPanelId = {
  ios: "ios-simulator",
  android: "android-emulator",
} as const;

/**
 * Whether the title bar has a toggle for a kind: in a Code session on the
 * desktop, on a computer that can run the kind, unless its Settings switch is
 * off.
 */
export function simulatorToggleShown({
  kind,
  mode,
  desktop,
  platform,
  settings,
}: {
  kind: SimulatorKind;
  mode: string;
  desktop: boolean;
  platform: string | undefined;
  settings: Record<string, unknown> | undefined;
}) {
  return (
    mode === "code" &&
    desktop &&
    platform !== undefined &&
    simulatorSupported(kind, platform) &&
    settings?.[accessPreference[kind]] !== false
  );
}

/** A failure the attach screen shows: the original's title, then what went wrong. */
export interface Failure {
  title: string;
  detail: string;
}

/** A device as the picker words it: "iPhone 17 (iOS 27.0)". */
export function deviceText(device: SimulatorDevice) {
  return device.osVersion
    ? `${device.name} (${device.osVersion})`
    : device.name;
}

/** The picker's two groups. */
export function pickerGroups(devices: readonly SimulatorDevice[]) {
  return {
    booted: devices.filter((device) => device.state === "booted"),
    available: devices.filter((device) => device.state === "shutdown"),
  };
}

/** The device "Attach" picks without a choice: a booted one, else the first that would boot. */
export function defaultDevice(devices: readonly SimulatorDevice[]) {
  const { booted, available } = pickerGroups(devices);
  return booted[0] ?? available[0];
}

// -- Setup -------------------------------------------------------------------

export type TileState = "done" | "current" | "upcoming";

export interface SetupTile {
  key: string;
  state: TileState;
  label: string;
  /** A line under the label. */
  sub?: string;
  /** A command to copy, shown under the line. */
  command?: string;
}

export interface SetupSteps {
  title: string;
  tiles: SetupTile[];
  /** What the check is looking for now ("Checking for Xcode…"). */
  polling: string;
  /** The button at the bottom, or none. */
  action?: { label: string; target: SimulatorOpenTarget };
  /** The trademark line above it. */
  footnote: string;
}

/**
 * The iOS steps: Install Xcode, Select Xcode (when the command-line tools point
 * somewhere else) and Install Simulator. `xcodeSelectFixPath` is the path to
 * select, or "" when it isn't known.
 */
export function iosSteps(status: IosSetupStatus): SetupSteps {
  const fix = status.xcodeSelectFixPath;
  const selectable = fix === undefined;
  const installed = status.xcode === true || !selectable;
  const simulators = status.simulators === true;
  const tiles: SetupTile[] = [
    {
      key: "xcode",
      state: installed ? "done" : "current",
      label: installed ? "Xcode installed" : "Install Xcode",
      sub: installed
        ? status.xcodeVersion
          ? `Version ${status.xcodeVersion}`
          : undefined
        : "Free from the Mac App Store.",
    },
  ];
  if (fix !== undefined)
    tiles.push({
      key: "select",
      state: "current",
      label: "Select Xcode",
      sub:
        fix === ""
          ? "Xcode is installed, but your Mac’s command-line tools don’t point at it. In Xcode, open Settings → Locations and pick your Xcode under Command Line Tools."
          : "Xcode is installed, but your Mac’s command-line tools don’t point at it. Paste this in Terminal, then press Enter and type your Mac password when it asks:",
      command: fix === "" ? undefined : `sudo xcode-select -s ${fix}`,
    });
  tiles.push({
    key: "simulators",
    state: simulators
      ? "done"
      : status.xcode === true && selectable
        ? "current"
        : "upcoming",
    label: simulators ? "Simulator installed" : "Install Simulator",
    sub: simulators
      ? undefined
      : selectable
        ? installed
          ? "When Xcode first opens, keep iOS selected and click Download & Install."
          : "Available once Xcode is installed."
        : "Available once Xcode is selected.",
  });
  return {
    title: "Set up the iOS simulator",
    tiles,
    polling: selectable
      ? installed
        ? "Checking for the simulator runtime…"
        : "Checking for Xcode…"
      : "Checking the selected Xcode…",
    action:
      fix === ""
        ? undefined
        : installed
          ? { label: "Open Xcode", target: "xcode" }
          : { label: "Open Mac App Store", target: "app-store" },
    footnote:
      "Xcode is a trademark of Apple Inc., registered in the U.S. and other countries.",
  };
}

/**
 * The Android steps: Android Studio (it bundles the SDK and emulator), its
 * setup wizard, a system image and a virtual device.
 */
export function androidSteps(status: AndroidSetupStatus): SetupSteps {
  const sdk = status.platformTools === true && status.emulator === true;
  const image = status.systemImage === true;
  const device = status.avd === true;
  const wizard = status.studioInstalled && !sdk;
  const tiles: SetupTile[] = [
    {
      key: "studio",
      state: sdk || status.studioInstalled ? "done" : "current",
      label: sdk
        ? "Android SDK installed"
        : status.studioInstalled
          ? "Android Studio installed"
          : "Install Android Studio",
      sub:
        sdk || status.studioInstalled
          ? undefined
          : "Free from developer.android.com. Bundles the SDK and emulator.",
    },
  ];
  if (wizard)
    tiles.push({
      key: "wizard",
      state: "current",
      label: "Finish the setup wizard",
      sub: "Open Android Studio and complete its setup wizard to install the SDK.",
    });
  tiles.push(
    {
      key: "image",
      state: image ? "done" : sdk ? "current" : "upcoming",
      label: image ? "System image installed" : "Install a system image",
      sub: image
        ? undefined
        : sdk
          ? "In Android Studio: Tools, then SDK Manager, then SDK Platforms."
          : "Available once the SDK is installed.",
    },
    {
      key: "device",
      state: device ? "done" : image ? "current" : "upcoming",
      label: device ? "Virtual device created" : "Create a virtual device",
      sub: device
        ? undefined
        : image
          ? "In Android Studio: Tools, then Device Manager, then Create device."
          : "Available once a system image is installed.",
    },
  );
  return {
    title: "Set up the Android emulator",
    tiles,
    polling: sdk
      ? image
        ? "Checking for a virtual device…"
        : "Checking for a system image…"
      : "Checking for the Android SDK…",
    action: status.studioInstalled
      ? { label: "Open Android Studio", target: "android-studio" }
      : { label: "Download Android Studio", target: "download-android-studio" },
    footnote: "Android is a trademark of Google LLC.",
  };
}

export function setupSteps(
  kind: SimulatorKind,
  status: IosSetupStatus | AndroidSetupStatus,
) {
  return kind === "ios"
    ? iosSteps(status as IosSetupStatus)
    : androidSteps(status as AndroidSetupStatus);
}

/** Whether the pane lists devices (the setup is complete). */
export function paneReady(
  kind: SimulatorKind,
  status: IosSetupStatus | AndroidSetupStatus,
) {
  return kind === "ios"
    ? iosSetupReady(status as IosSetupStatus)
    : androidSetupReady(status as AndroidSetupStatus);
}

// -- The screen --------------------------------------------------------------

/** Pointer movement under this many pixels is a tap, not a swipe. */
export const tapSlop = 6;
/** A press this long is a long press. */
export const longPressMs = 500;

export interface Press {
  x: number;
  y: number;
  at: number;
}

/**
 * What a press and release on the screen picture mean, in fractions of the
 * picture: a tap (a long press after half a second), or a swipe over the
 * time the pointer took. Undefined when the pointer ended outside the
 * picture and never moved there.
 */
export function gestureOf(
  start: Press,
  end: Press,
  box: { left: number; top: number; width: number; height: number },
): SimulatorInput | undefined {
  if (box.width <= 0 || box.height <= 0) return undefined;
  const fraction = (x: number, y: number) => ({
    x: Math.min(1, Math.max(0, (x - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (y - box.top) / box.height)),
  });
  const from = fraction(start.x, start.y);
  const seconds = Math.max(0, (end.at - start.at) / 1000);
  if (Math.hypot(end.x - start.x, end.y - start.y) < tapSlop)
    return {
      type: "tap",
      ...from,
      ...(seconds * 1000 >= longPressMs ? { duration: seconds } : {}),
    };
  const to = fraction(end.x, end.y);
  return {
    type: "swipe",
    x: from.x,
    y: from.y,
    x2: to.x,
    y2: to.y,
    duration: Math.min(Math.max(seconds, 0.1), 2),
  };
}

/** A key pressed on the focused screen: text to type, or Enter / Backspace. */
export type KeyPress = { text: string } | { key: "ENTER" | "BACKSPACE" };

/** What a key does on the device; undefined for shortcuts, arrows and the like. */
export function keyPress(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): KeyPress | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  if (event.key === "Enter") return { key: "ENTER" };
  if (event.key === "Backspace") return { key: "BACKSPACE" };
  // A single character (a letter, a digit, a space or a symbol).
  return Array.from(event.key).length === 1 ? { text: event.key } : undefined;
}

/** How long to wait before the next screen picture: the pane is a poll, not a stream. */
export const screenIntervalMs = 350;
/** After a failed picture the wait grows to this. */
export const screenRetryMs = 2000;

// -- The picker ----------------------------------------------------------------

/**
 * The picker's second line: the OS version, and for a running emulator its
 * serial after a middle dot.
 */
export function deviceDetail(device: SimulatorDevice): string | undefined {
  if (device.kind !== "android") return device.osVersion || undefined;
  const serial = device.id !== device.avd ? device.id : undefined;
  return [device.osVersion, serial].filter(Boolean).join(" · ") || undefined;
}

/** A long name keeps this many of its last characters whole. */
const keptTail = 7;

/**
 * A device name split for the picker: a name over 14 characters shrinks with an
 * ellipsis before its last characters, so the model suffix at the end stays
 * readable ("iPhone 17… Pro Max": the space before the tail goes with it).
 */
export function nameParts(name: string): { head: string; tail?: string } {
  if (name.length <= 14) return { head: name };
  const cut =
    name.length - keptTail - (name[name.length - keptTail - 1] === " " ? 1 : 0);
  return { head: name.slice(0, cut), tail: name.slice(cut) };
}

// -- Zoom ----------------------------------------------------------------------

/**
 * How the screen is sized: fitted to the pane, one point to one CSS pixel
 * ("physical"), or a fixed number of CSS pixels per device pixel.
 */
export type ZoomMode = "fit" | "physical" | number;
export type ZoomAction = "in" | "out" | "fit" | "physical";

/** Each Zoom in or out multiplies or divides by this. */
export const zoomStep = 1.25;
/** The smallest zoom: one CSS pixel for eight device pixels. */
export const zoomMin = 1 / 8;
/** The largest: one CSS pixel for each device pixel. */
export const zoomMax = 1;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** CSS pixels per device pixel at Physical size, or null when the device doesn't say. */
export function physicalZoom(screen: {
  pixelsPerPoint?: number;
}): number | null {
  const ratio = screen.pixelsPerPoint;
  return ratio !== undefined && ratio > 0 ? 1 / ratio : null;
}

/** One step in or out from `zoom`, or undefined at the end of the range. */
export function stepZoom(zoom: number, direction: "in" | "out") {
  if (direction === "in")
    return zoom < zoomMax * 0.99
      ? Math.min(zoom * zoomStep, zoomMax)
      : undefined;
  return zoom > zoomMin * 1.01
    ? Math.min(Math.max(zoom / zoomStep, zoomMin), zoomMax)
    : undefined;
}

/**
 * The mode an action leads to, or undefined when it does nothing: `current`
 * is the zoom now (measured while fitted; null before the picture is drawn)
 * and `physical` the Physical size zoom (null when the device doesn't say).
 */
export function nextZoom(
  action: ZoomAction,
  mode: ZoomMode,
  current: number | null,
  physical: number | null,
): ZoomMode | undefined {
  if (action === "fit") return mode === "fit" ? undefined : "fit";
  if (action === "physical")
    return physical === null ||
      mode === "physical" ||
      (current !== null && near(current, physical))
      ? undefined
      : "physical";
  if (current === null) return undefined;
  const next = stepZoom(current, action);
  return next !== undefined && physical !== null && near(next, physical)
    ? "physical"
    : next;
}

/** The zoom a mode draws at, or null while fitted. */
export function zoomOf(mode: ZoomMode, physical: number | null): number | null {
  if (mode === "fit") return null;
  if (mode === "physical") return physical;
  return mode;
}

/**
 * The zoom shortcuts on the focused screen: ⌘- out, ⌘0 fit, ⌘1 physical, ⌘+ in;
 * Ctrl off the Mac.
 */
export function zoomShortcut(
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  mac: boolean,
): ZoomAction | undefined {
  const mod = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return undefined;
  switch (event.key) {
    case "-":
    case "_":
      return "out";
    case "=":
    case "+":
      return "in";
    case "0":
      return event.shiftKey ? undefined : "fit";
    case "1":
      return event.shiftKey ? undefined : "physical";
  }
  return undefined;
}
