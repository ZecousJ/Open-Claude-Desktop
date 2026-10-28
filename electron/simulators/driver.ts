/**
 * What the simulator service needs from a platform: the iOS driver
 * (`ios.ts`, `xcrun simctl` and idb) and the Android driver (`android.ts`,
 * `adb` and `emulator`) both implement it, so the tools, the pane and the
 * consent rules are written once.
 */
import type {
  KeyName,
  SimulatorAppearance,
  SimulatorDevice,
  SimulatorKind,
  SimulatorEditAction,
  SimulatorLogEntry,
} from "../../shared/simulators";
import type { RunningProcess } from "./runner";

export interface TouchPoint {
  x: number;
  y: number;
  /** Milliseconds to wait before this sample. */
  dtMs: number;
}

/** What `text` did: Android drops characters it can't type safely. */
export interface TextResult {
  typed: number;
  dropped: number;
}

/** The size of the space taps are given in (iOS points, Android pixels). */
export interface InputSpace {
  width: number;
  height: number;
}

/** The app a launch started. */
export interface LaunchResult {
  /** The bundle identifier or package id. */
  appId: string;
}

export interface DeviceDriver {
  readonly kind: SimulatorKind;
  /** Booted devices first, then the ones that would boot. */
  list(): Promise<SimulatorDevice[]>;
  /** Boots a device and waits until it is up; returns it as the list now shows it. */
  boot(id: string): Promise<SimulatorDevice>;
  shutdown(id: string): Promise<void>;
  /** Renames a device (iOS: `simctl rename`). */
  rename?(id: string, name: string): Promise<void>;
  /** A PNG of the whole screen. */
  screenshot(id: string): Promise<Buffer>;
  /**
   * The space taps are given in. iOS: the device's size in points, which
   * only idb reports (undefined without it); Android: the screenshot's
   * pixels, read from `screenshot`.
   */
  inputSpace(id: string, screenshot?: Buffer): Promise<InputSpace | undefined>;
  /**
   * How many of the screenshot's pixels make one point (iOS) or one
   * density-independent pixel (Android), for the pane's Physical size;
   * undefined when the device doesn't say (iOS without idb).
   */
  pixelsPerPoint?(id: string, screenshot: Buffer): Promise<number | undefined>;
  /** Touch input works (iOS needs idb). */
  inputAvailable(): Promise<boolean>;
  tap(id: string, x: number, y: number, durationSec?: number): Promise<void>;
  swipe(
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationSec: number,
  ): Promise<void>;
  /** A one-finger drag along samples. */
  touchPath(id: string, points: TouchPoint[]): Promise<void>;
  text(id: string, value: string): Promise<TextResult>;
  button(id: string, name: string): Promise<void>;
  /** Enter or Backspace on the keyboard. */
  key(id: string, name: KeyName): Promise<void>;
  rotate?(id: string): Promise<void>;
  edit?(id: string, action: SimulatorEditAction): Promise<void>;
  openUrl(id: string, url: string): Promise<void>;
  /** Installs an app bundle or APK and starts it. */
  launch(id: string, appPath: string, appId?: string): Promise<LaunchResult>;
  /** Device → Appearance (iOS): reads it, or sets it first; null when unknown. */
  appearance?(
    id: string,
    set?: SimulatorAppearance,
  ): Promise<SimulatorAppearance | null>;
  /** The device's pasteboard text (iOS). */
  readPasteboard?(id: string): Promise<string>;
  /** Puts text on the device's pasteboard (iOS). */
  writePasteboard?(id: string, text: string): Promise<void>;
  /**
   * Starts recording the screen into `file` (iOS); resolves once the
   * recording runs. SIGINT finishes the movie.
   */
  record?(id: string, file: string): Promise<RunningProcess>;
  /** The process that streams the device's log, and how to read its lines. */
  logStream?(id: string): Promise<LogStream>;
  /**
   * Device → Show on-screen keyboard (Android): whether it shows beside the
   * hardware keyboard; sets it first when `show` is given.
   */
  softwareKeyboard?(id: string, show?: boolean): Promise<boolean>;
  /**
   * The screen's elements for the inspector, frames in the device's input
   * space (iOS points, Android pixels), and that space's size.
   */
  elements?(id: string): Promise<{ elements: RawElement[]; space: InputSpace }>;
  /** A foldable's hinge angle in degrees; null without a hinge. Sets it first when given. */
  hinge?(id: string, degrees?: number): Promise<number | null>;
  /** Airplane mode (Android): whether it is on; switches it first when `on` is given. */
  airplaneMode?(id: string, on?: boolean): Promise<boolean>;
  /** Device → Slow animations (Android): whether they are slowed; sets it first when `on` is given. */
  slowAnimations?(id: string, on?: boolean): Promise<boolean>;
}

/** An element as the device describes it (frame in its own units). */
export interface RawElement {
  type: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame: { x: number; y: number; width: number; height: number };
  depth: number;
  enabled?: boolean;
}

/** A log-streaming command and its line reader. */
export interface LogStream {
  file: string;
  args: string[];
  /** One line of output as a log entry; null for lines that aren't entries. */
  parse(line: string, now: number): Omit<SimulatorLogEntry, "seq"> | null;
}

/** An error the person or Claude can act on (the message is shown as is). */
export class SimulatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatorError";
  }
}
