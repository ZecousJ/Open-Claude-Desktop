/**
 * Mobile simulators: the iOS Simulator and Android Emulator panes of Code and
 * the device tools Claude uses. The data types live in `shared/simulators.ts`;
 * the handlers are in `electron/ipc/simulators.ts`. Desktop only: the web app
 * has no devices to drive.
 */
import { bridgeMethods } from "./bridge-methods";
import type { Attachment } from "./types";
import type {
  SimulatorElement,
  AndroidSetupStatus,
  ClipboardDirection,
  IosSetupStatus,
  SimulatorAnnotateCapture,
  SimulatorAppearance,
  SimulatorCapture,
  SimulatorLogBatch,
  SimulatorDevice,
  SimulatorInput,
  SimulatorKind,
  SimulatorOpenTarget,
  SimulatorScreen,
  SimulatorsState,
} from "./simulators";

export interface SimulatorsAPI {
  simulatorSetSubscribed(
    kind: SimulatorKind,
    id: string,
    subscribed: boolean,
    fps?: number,
  ): Promise<void>;
  /** Which kinds this computer can run and whether Settings lets Claude use them. */
  simulatorsState(): Promise<SimulatorsState>;
  /** The setup check: Xcode and its simulators, or the Android SDK, emulator and a virtual device. */
  simulatorSetup(
    kind: SimulatorKind,
  ): Promise<IosSetupStatus | AndroidSetupStatus>;
  /** Booted devices and the ones that would boot, booted first. */
  simulatorDevices(kind: SimulatorKind): Promise<SimulatorDevice[]>;
  /** Boots a device and waits until it is up (a cold Android boot takes minutes). */
  simulatorBoot(kind: SimulatorKind, id: string): Promise<void>;
  /** Shuts a device down ("Shut down {name}"). */
  simulatorShutdown(kind: SimulatorKind, id: string): Promise<void>;
  /** Restart: shuts a device down and boots it; its id afterwards (an emulator's serial changes). */
  simulatorRestart(kind: SimulatorKind, id: string): Promise<string>;
  /** Inspect: the screen's elements, frames in fractions of the screen. */
  simulatorInspect(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorElement[]>;
  /** Rename… (iOS). */
  simulatorRename(kind: SimulatorKind, id: string, name: string): Promise<void>;
  /** One picture of the device's screen; null when it can't be taken. */
  simulatorScreen(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorScreen | null>;
  /** A tap, swipe, text or button the person made on the pane. */
  simulatorInput(
    kind: SimulatorKind,
    id: string,
    input: SimulatorInput,
  ): Promise<void>;
  /** Whether Claude may use this device (the person allowed it before). */
  simulatorAccess(kind: SimulatorKind, id: string): Promise<boolean>;
  /** "Let Claude use it": the person's answer for this device. */
  simulatorAllow(
    kind: SimulatorKind,
    id: string,
    allow: boolean,
  ): Promise<void>;
  /** The setup screens' buttons: Xcode, the App Store, Android Studio and its download page. */
  simulatorOpen(target: SimulatorOpenTarget): Promise<boolean>;
  /** Save screenshot: a PNG of the screen on the Desktop, with its corner thumbnail. */
  simulatorSaveScreenshot(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorCapture>;
  /** Annotate: the screen as a full-size PNG for the annotation editor (nothing is saved). */
  simulatorCaptureScreenshot(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorAnnotateCapture>;
  /** Record video (iOS): starts recording the screen. */
  simulatorStartRecording(kind: SimulatorKind, id: string): Promise<void>;
  /** Stop recording: the movie on the Desktop. */
  simulatorStopRecording(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorCapture>;
  /**
   * A saved capture's menu: show it in Finder, delete it, or keep it as an
   * attachment for the composer ("Attach as context", screenshots only).
   * Only captures this app saved can be named.
   */
  simulatorCaptureAction(
    path: string,
    action: "reveal" | "delete",
  ): Promise<boolean>;
  simulatorAttachCapture(path: string): Promise<Attachment>;
  /** Device → Appearance (iOS): the current one, or set it; null when it can't be read. */
  simulatorAppearance(
    kind: SimulatorKind,
    id: string,
    set?: SimulatorAppearance,
  ): Promise<SimulatorAppearance | null>;
  /**
   * Device → Show on-screen keyboard (Android): whether it shows beside the
   * emulator's hardware keyboard, after setting it when `show` is given;
   * null when the device can't say.
   */
  simulatorSoftwareKeyboard(
    kind: SimulatorKind,
    id: string,
    show?: boolean,
  ): Promise<boolean | null>;
  /** A foldable's hinge angle in degrees (0–180), after setting it when given; null without a hinge. */
  simulatorHinge(
    kind: SimulatorKind,
    id: string,
    degrees?: number,
  ): Promise<number | null>;
  /** Device → Slow animations, after setting it when `on` is given; null when it can't say. */
  simulatorSlowAnimations(
    kind: SimulatorKind,
    id: string,
    on?: boolean,
  ): Promise<boolean | null>;
  /**
   * Edit → Get clipboard (the device's pasteboard to this computer's
   * clipboard) or Send clipboard (the other way), iOS. Returns how many
   * characters went across.
   */
  simulatorClipboard(
    kind: SimulatorKind,
    id: string,
    direction: ClipboardDirection,
  ): Promise<number>;
  /**
   * The device's log lines after `since` (starts reading the log on the
   * first call; the reading stops a while after the calls stop).
   */
  simulatorLogs(
    kind: SimulatorKind,
    id: string,
    since: number,
  ): Promise<SimulatorLogBatch>;
  /** Close logs: stops reading the device's log now. */
  simulatorLogsStop(kind: SimulatorKind, id: string): Promise<void>;
}

export const simulatorsMethods = bridgeMethods<SimulatorsAPI>({
  simulatorSetSubscribed: true,
  simulatorsState: true,
  simulatorSetup: true,
  simulatorDevices: true,
  simulatorBoot: true,
  simulatorShutdown: true,
  simulatorRestart: true,
  simulatorRename: true,
  simulatorInspect: true,
  simulatorScreen: true,
  simulatorInput: true,
  simulatorAccess: true,
  simulatorAllow: true,
  simulatorOpen: true,
  simulatorSaveScreenshot: true,
  simulatorCaptureScreenshot: true,
  simulatorStartRecording: true,
  simulatorStopRecording: true,
  simulatorCaptureAction: true,
  simulatorAttachCapture: true,
  simulatorAppearance: true,
  simulatorSoftwareKeyboard: true,
  simulatorSlowAnimations: true,
  simulatorHinge: true,
  simulatorClipboard: true,
  simulatorLogs: true,
  simulatorLogsStop: true,
});
