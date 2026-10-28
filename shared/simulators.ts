/**
 * Mobile simulators in Code. The types and the pure rules both the window and
 * the main process use; the main process's commands are in
 * `electron/simulators/`.
 *
 * The iOS Simulator needs a Mac with Xcode; the Android Emulator runs on a Mac
 * or Windows with the Android SDK. Only emulators and simulators are supported,
 * never a physical phone.
 */

export type SimulatorKind = "ios" | "android";

export const simulatorKinds: readonly SimulatorKind[] = ["ios", "android"];

/** The name the pane and the settings row give each kind (messages fc+oEygAS4, yUsyxi1gKs). */
export const simulatorKindLabel: Record<SimulatorKind, string> = {
  ios: "iOS Simulator",
  android: "Android Emulator",
};

/** "Simulator" or "emulator", as the original words each kind's texts. */
export const simulatorNoun: Record<SimulatorKind, string> = {
  ios: "simulator",
  android: "emulator",
};

export type SimulatorDeviceState =
  "booted" | "booting" | "shutdown" | "shutting-down";

export interface SimulatorDevice {
  kind: SimulatorKind;
  /**
   * iOS: the UDID. Android: the adb serial (`emulator-5554`) of a running
   * emulator, else the virtual device's name.
   */
  id: string;
  /** The name the picker shows ("iPhone 17 Pro", "Pixel 10 Pro API 36.0"). */
  name: string;
  state: SimulatorDeviceState;
  /** iOS: the runtime ("iOS 27.0"). */
  osVersion?: string;
  /** Android: the virtual device (AVD) name, whether or not it is running. */
  avd?: string;
}

/** What the iOS check found; undefined is unknown. */
export interface IosSetupStatus {
  xcode?: boolean;
  xcodeVersion?: string;
  simulators?: boolean;
  /**
   * Xcode is installed but the command-line tools point elsewhere: the path
   * to select with `sudo xcode-select -s`, or "" when that path is not known.
   */
  xcodeSelectFixPath?: string;
  /**
   * Facebook idb is installed, which Claudex uses to tap, swipe, type and
   * press buttons (the simulator has no command line for touch input).
   */
  input: boolean;
}

/** What the Android check found (`checkAndroidSetup`); undefined is unknown. */
export interface AndroidSetupStatus {
  studioInstalled: boolean;
  platformTools?: boolean;
  emulator?: boolean;
  systemImage?: boolean;
  avd?: boolean;
  sdkRoot?: string;
}

export type SimulatorSetupStatus<K extends SimulatorKind = SimulatorKind> =
  K extends "ios" ? IosSetupStatus : AndroidSetupStatus;

/** The iOS pane lists devices once Xcode, its simulators and the selection are right. */
export function iosSetupReady(status: IosSetupStatus) {
  return (
    status.xcode === true &&
    status.simulators === true &&
    status.xcodeSelectFixPath === undefined
  );
}

/** The Android pane lists devices once the SDK, the emulator and a virtual device exist. */
export function androidSetupReady(status: AndroidSetupStatus) {
  return (
    status.platformTools === true &&
    status.emulator === true &&
    status.systemImage !== false &&
    status.avd === true
  );
}

export function setupReady(
  kind: SimulatorKind,
  status: IosSetupStatus | AndroidSetupStatus,
) {
  return kind === "ios"
    ? iosSetupReady(status as IosSetupStatus)
    : androidSetupReady(status as AndroidSetupStatus);
}

/** What the window knows about the simulators before it asks for more. */
export interface SimulatorsState {
  platform: "darwin" | "win32" | "linux";
  ios: SimulatorKindState;
  android: SimulatorKindState;
}

export interface SimulatorKindState {
  /** This computer can run this kind (iOS: macOS; Android: macOS or Windows). */
  supported: boolean;
  /** The Settings switch (on unless turned off). */
  enabled: boolean;
}

/** Whether a kind runs on a platform (the original's `iosSimulator` / `androidEmulator` gates). */
export function simulatorSupported(
  kind: SimulatorKind,
  platform: string,
): boolean {
  return kind === "ios"
    ? platform === "darwin"
    : platform === "darwin" || platform === "win32";
}

/** One picture of a device's screen. */
export interface SimulatorScreen {
  /** `data:image/jpeg;base64,…` (or png). */
  dataUrl: string;
  /** The picture's size in pixels. */
  width: number;
  height: number;
  /** The device screen's own size in pixels (the picture is scaled down from it). */
  deviceWidth?: number;
  deviceHeight?: number;
  /**
   * Device pixels per point (iOS) or per density-independent pixel
   * (Android): the pane's Physical size draws one point as one CSS pixel.
   * Absent when the device doesn't report it (iOS without idb).
   */
  pixelsPerPoint?: number;
}

/** Hardware buttons by kind (the tool's `name` enum). */
export const iosButtons = [
  "HOME",
  "LOCK",
  "SIRI",
  "SIDE_BUTTON",
  "APPLE_PAY",
] as const;
export const androidButtons = [
  "HOME",
  "BACK",
  "RECENTS",
  "LOCK",
  "VOLUME_UP",
  "VOLUME_DOWN",
] as const;
/** Keys typed on the pane that are not characters. */
export const keyNames = ["ENTER", "BACKSPACE"] as const;
export type KeyName = (typeof keyNames)[number];
export type IosButton = (typeof iosButtons)[number];
export type AndroidButton = (typeof androidButtons)[number];

/**
 * What a person does in the pane. Positions are fractions of the screen
 * (0 to 1 from the top left), so the main process maps them to the device's
 * own space.
 */
export type SimulatorInput =
  | { type: "rotate" }
  | { type: "edit"; action: SimulatorEditAction }
  | { type: "tap"; x: number; y: number; duration?: number }
  | {
      type: "swipe";
      x: number;
      y: number;
      x2: number;
      y2: number;
      duration?: number;
    }
  | { type: "text"; value: string }
  | { type: "button"; name: IosButton | AndroidButton }
  /** Enter and Backspace, which are not text. */
  | { type: "key"; name: KeyName };

export const simulatorEditActions = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
] as const;
export type SimulatorEditAction = (typeof simulatorEditActions)[number];

/** The most characters one text input carries. */
export const simulatorTextLimit = 2000;

// -- The control bar and menus ------------

/** Only the iOS Simulator records video (`simctl io recordVideo`; the original offers no Android recording). */
export function canRecord(kind: SimulatorKind) {
  return kind === "ios";
}

/**
 * A screenshot or recording the control bar saved: "Save screenshot" and
 * "Record video" write to the Desktop as the original does.
 */
export interface SimulatorCapture {
  kind: "screenshot" | "recording";
  /** The file's full path. */
  path: string;
  /** The corner thumbnail, at most 240 pixels on its longer edge. */
  thumbnail?: { dataUrl: string; width: number; height: number };
  /**
   * A recording that couldn't be moved to the Desktop and stays where it was
   * recorded ("Recording saved to {filePath} but couldn’t be moved to the
   * Desktop").
   */
  kept?: boolean;
}

/**
 * One element of the screen for the inspector (iOS: idb's accessibility
 * description; Android: uiautomator's view hierarchy). The frame is in
 * fractions of the screen, so the pane can draw it over any zoom.
 */
export interface SimulatorElement {
  /** Its place in the list, stable for one reading ("12"). */
  path: string;
  /** "Button", "StaticText", "android.widget.TextView". */
  type: string;
  /** The accessibility label, or the view's text or content description. */
  label?: string;
  value?: string;
  /** The accessibility identifier or Android resource id. */
  identifier?: string;
  frame: { x: number; y: number; width: number; height: number };
  /** The frame in the device's own units (iOS points, Android pixels). */
  bounds?: { x: number; y: number; width: number; height: number };
  /** How deep it sits (later and deeper elements are in front). */
  depth: number;
  enabled?: boolean;
}

/**
 * A screenshot for Annotate: the screen at full size as a PNG, kept in
 * memory only (the original's `captureScreenshot(udid, "annotate")`).
 */
export interface SimulatorAnnotateCapture {
  /** `data:image/png;base64,…` */
  dataUrl: string;
  width: number;
  height: number;
  /** The file name the annotated picture is attached under, without ".png". */
  name: string;
}

/** The longer edge of a capture's corner thumbnail. */
export const captureThumbnailEdge = 240;

/**
 * A capture's file name without its extension, as the original builds it:
 * "Simulator Screenshot - iPhone 17 - 2026-10-12 at 09.41.07". The device
 * name loses characters a file name can't hold and is cut to 60 characters.
 */
export function captureBaseName(
  prefix: "Simulator Screenshot" | "Simulator Recording",
  deviceName: string,
  date: Date,
) {
  let name = deviceName
    .replace(/[/\\:<>"|?*\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 60);
  // Room for the rest of the name within a file system's 255 bytes.
  while (new TextEncoder().encode(name).length > 186) name = name.slice(0, -1);
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} at ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
  return `${prefix} - ${name || "Device"} - ${stamp}`;
}

/** The iOS Simulator's appearance (Device → Appearance; `simctl ui appearance`). */
export type SimulatorAppearance = "light" | "dark";

/**
 * Edit → Get clipboard / Send clipboard: the device's pasteboard to this
 * computer's clipboard, or the other way (`simctl pbpaste` / `pbcopy`).
 */
export type ClipboardDirection = "get" | "send";

/** The most text a clipboard transfer carries (the original's 1,000,000 characters). */
export const clipboardTextLimit = 1_000_000;

/**
 * A log line's level (the unified log's: Debug, Info, Default, Error,
 * Fault; a crash report is Crash). Android's Warning is "default".
 */
export type SimulatorLogLevel =
  "debug" | "info" | "default" | "error" | "fault" | "crash";

/** The levels in order, lowest first. */
export const simulatorLogLevels: readonly SimulatorLogLevel[] = [
  "debug",
  "info",
  "default",
  "error",
  "fault",
  "crash",
];

/** Whether a line's level is at least `min`. */
export function logLevelAtLeast(
  level: SimulatorLogLevel,
  min: SimulatorLogLevel,
) {
  return simulatorLogLevels.indexOf(level) >= simulatorLogLevels.indexOf(min);
}

/** One line of a device's log. */
export interface SimulatorLogEntry {
  /** Counts up from 1 within one capture. */
  seq: number;
  /** Milliseconds since 1970. */
  ts: number;
  level: SimulatorLogLevel;
  /** The process's name (Android: its pid). */
  process: string;
  pid: number;
  /** iOS: the subsystem ("com.apple.xpc"); Android: the tag. */
  subsystem?: string;
  category?: string;
  message: string;
}

/** What one read of a device's log returns. */
export interface SimulatorLogBatch {
  /** The lines after the `since` asked for, oldest first. */
  entries: SimulatorLogEntry[];
  /** A new capture (the stream was restarted) starts its seq again from 1. */
  captureId: number;
  /** Why the capture stopped, once it has. */
  ended?: string;
}

/** The scope column: the subsystem's last part and the category. */
export function logScope(entry: {
  subsystem?: string;
  category?: string;
}): string {
  return [entry.subsystem?.split(".").at(-1), entry.category]
    .filter(Boolean)
    .join(":");
}

/** The full scope a scope chip filters by ("com.apple.xpc:connection"). */
export function logScopeFull(entry: {
  subsystem?: string;
  category?: string;
}): string {
  return [entry.subsystem, entry.category].filter(Boolean).join(":");
}

/** Where the setup screens send the person. */
export const xcodeStoreUrl = "https://apps.apple.com/app/xcode/id497799835";
export const androidStudioUrl = "https://developer.android.com/studio";

/** What the setup screens' buttons ask the main process to open. */
export type SimulatorOpenTarget =
  "xcode" | "app-store" | "android-studio" | "download-android-studio";

// -- Identifiers -------------------------------------------------------------

/** A simulator's UDID. */
export const udidPattern =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
/** An adb serial of an emulator, never a phone (`emulator-5554`). */
export const emulatorSerialPattern = /^emulator-\d{4,5}$/;
/** A virtual device's name (what `emulator -avd` takes). */
export const avdNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** An iOS bundle identifier. */
export const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** An Android package id (`com.example.app`). */
export const androidPackagePattern =
  /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** A device name's limit (the original's Rename simulator: 64 characters). */
export const deviceNameLimit = 64;

function hiddenCharacter(code: number) {
  return (
    code < 32 ||
    (code >= 127 && code <= 159) ||
    code === 6158 ||
    code === 8232 ||
    code === 8233 ||
    (code >= 55296 && code <= 57343) ||
    (code >= 65529 && code <= 65531) ||
    /\p{Default_Ignorable_Code_Point}/u.test(String.fromCodePoint(code))
  );
}

/**
 * Why a new device name can't be used: empty, a hidden character, a leading
 * hyphen (simctl would read an option) or more than 64 characters; undefined
 * when fine.
 */
export function deviceNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "Enter a name.";
  if ([...name].some((char) => hiddenCharacter(char.codePointAt(0)!)))
    return "A name can’t contain hidden characters. Some emoji include them.";
  if (name.startsWith("-")) return "A name can’t start with a hyphen.";
  const segments =
    typeof Intl.Segmenter === "function"
      ? [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            name,
          ),
        ].length
      : [...name].length;
  if (segments > deviceNameLimit) return "Use 64 characters or fewer.";
  return undefined;
}

export function validDeviceId(kind: SimulatorKind, id: string): boolean {
  return kind === "ios"
    ? udidPattern.test(id)
    : emulatorSerialPattern.test(id) || avdNamePattern.test(id);
}

// -- Consent -----------------------------------------------------------------

/** The key a device's consent is kept under: `ios:<udid>`, `android:<avd or serial>`. */
export function consentKey(kind: SimulatorKind, device: string) {
  return `${kind}:${device}`;
}

/**
 * The text of the ask-before-use dialog (messages QueJA2rQ6+, LCiunPPPGP,
 * HUsmsyBuuf, p/HID6CXLv, w0OsNPP8iq, fugwx2aUPz): one paragraph about
 * what Claude will do, one about where the screenshots go and one about
 * real accounts.
 */
export function consentText(kind: SimulatorKind, deviceLabel: string) {
  return {
    title: "Simulator access",
    message: `Allow Claudex to use ${deviceLabel}?`,
    detail: [
      `Claudex will control this ${simulatorNoun[kind]} and take screenshots of its entire screen.`,
      "Screenshots are sent to the model and kept according to your normal conversation retention settings.",
      "Do not sign in to real accounts on this device.",
    ].join("\n\n"),
    buttons: ["Cancel", "Allow"],
  };
}

/** Updated tool consent. */
export function deviceToolsConsentText() {
  return {
    title: "Device tools access",
    message: "Re-approve Claudex's device tools?",
    detail:
      "The device tools on this computer changed after Claudex last approved them. This usually happens when the SDK is updated. Click Allow to let Claudex use the updated tools. If you did not expect this change, click Cancel.",
    buttons: ["Cancel", "Allow"],
  };
}

export const simulatorAutoModeNote =
  "This session is in Auto mode, so Claudex is using {device} without asking. In other permission modes, Claudex asks first.";

/** A device name for a dialog: one line, at most 64 characters. */
export function deviceLabel(name: string) {
  const text = name.replace(/\s+/g, " ").trim().slice(0, 1024);
  if (!text) return "(unnamed device)";
  const characters = Array.from(text);
  return characters.length > 64 ? `${characters.slice(0, 63).join("")}…` : text;
}
