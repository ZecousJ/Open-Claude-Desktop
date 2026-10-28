import {
  type AndroidSetupStatus,
  type IosSetupStatus,
  type SimulatorKind,
} from "../../shared/simulators";
import { type InputSpace } from "./driver";
import { type ScaledImage } from "./png";
import type { ControlResult } from "./service";

export const text = (value: string, success = true): ControlResult => ({
  success,
  parts: [{ type: "text", text: value }],
});

/** Claude's calls reuse a setup check this recent. */
export const setupFreshMs = 15_000;

export const setupRecheckMs = 60_000;

/** The longest edge of a picture Claude is sent. */
export const modelImageEdge = 1280;

/** The longest edge of a picture in the pane (it is redrawn twice a second). */
export const paneImageEdge = 1000;

/** A device that didn't say its pixels per point is asked again after this long. */
export const densityRetryMs = 30_000;

/** The size to scale to so the longer edge is at most `edge` (never up). */
export function fitWithin(size: InputSpace, edge: number): InputSpace {
  const factor = Math.min(1, edge / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  };
}

export const dataUrl = (image: ScaledImage) =>
  `data:${image.mimeType};base64,${image.data.toString("base64")}`;

/** Why a kind can't be used yet, from its setup check (the original's messages). */
export function setupProblem(
  kind: SimulatorKind,
  status: IosSetupStatus | AndroidSetupStatus,
) {
  if (kind === "ios") {
    const ios = status as IosSetupStatus;
    if (ios.xcodeSelectFixPath)
      return `Xcode is installed but not selected. Run \`sudo xcode-select -s ${ios.xcodeSelectFixPath}\` to use the Claudex Code iOS Simulator.`;
    if (ios.xcodeSelectFixPath === "")
      return "Xcode is installed but not selected. Select it in Xcode → Settings → Locations → Command Line Tools to use the Claudex Code iOS Simulator.";
    if (ios.xcode === false)
      return "Xcode not found. Install Xcode to use the Claudex Code iOS Simulator.";
    if (ios.simulators === false)
      return "The selected Xcode doesn’t have the iOS simulator yet. In Xcode, open Settings → Components and download iOS, or run `xcodebuild -downloadPlatform iOS`.";
    return "Checking the iOS Simulator setup didn't finish. Try again in a moment.";
  }
  const android = status as AndroidSetupStatus;
  if (android.platformTools === false)
    return "Couldn't find `adb`. Install Android SDK platform-tools (or set ANDROID_HOME).";
  if (android.emulator === false)
    return "Android emulator launcher not found. Install the Android SDK emulator (or set ANDROID_HOME), or start a device manually.";
  if (android.avd === false)
    return "No AVDs are configured. Create one in Android Studio's Device Manager.";
  return "Checking the Android Emulator setup didn't finish. Try again in a moment.";
}
