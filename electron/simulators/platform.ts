/**
 * What the simulator service needs from this computer, and the factory that
 * builds the service from it. The parts that touch Electron (the dialog, the
 * browser, image scaling) are in `electron-platform.ts`; this file only uses
 * Node, so the IPC domain and its tests load it without Electron.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { simulatorToolSpecs } from "./tool-schemas";
import {
  androidStudioUrl,
  type consentText,
  type SimulatorKind,
  type SimulatorOpenTarget,
} from "../../shared/simulators";
import { AndroidDriver } from "./android";
import { Consent, type DialogAnswer } from "./consent";
import type { DeviceDriver, InputSpace } from "./driver";
import { IosDriver } from "./ios";
import { SimulatorMedia, nodeCaptureFiles } from "./media";
import type { ImageScaler, ScaledImage } from "./png";
import type { Runner } from "./runner";
import { SimulatorService } from "./service";
import {
  androidStudioLocations,
  checkAndroidSetup,
  checkIosSetup,
  findAndroidTools,
  findIdb,
  type Environment,
  type FileProbe,
} from "./toolchain";

export interface SimulatorPlatform {
  environment: Environment;
  probe: FileProbe;
  runner: Runner;
  scaler: ImageScaler;
  /** The ask-before-use dialog. */
  ask(text: ReturnType<typeof consentText>): Promise<DialogAnswer>;
  /** Opens a web page in the person's browser. */
  openExternal(url: string): Promise<void>;
  /** Where Save screenshot and Record video put their files (the Desktop). */
  captureFolder(): string;
  /** This computer's clipboard text (Edit → Get clipboard / Send clipboard). */
  clipboard: {
    read(): string | Promise<string>;
    write(text: string): void | Promise<void>;
  };
  /** Shows a saved capture in Finder. */
  reveal(file: string): void;
  /** A recording's first frame for its corner thumbnail. */
  thumbnail?(file: string, size: InputSpace): Promise<ScaledImage | undefined>;
  /** Runs once as the app quits (recordings are finished, log streams stopped). */
  onQuit?(listener: () => void): void;
}

/** The files of this computer. */
export const nodeProbe: FileProbe = {
  async exists(file) {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  },
  async isDirectory(file) {
    try {
      return (await fs.stat(file)).isDirectory();
    } catch {
      return false;
    }
  },
  async isFile(file) {
    try {
      return (await fs.stat(file)).isFile();
    } catch {
      return false;
    }
  },
  async list(folder) {
    try {
      return await fs.readdir(folder);
    } catch {
      return [];
    }
  },
  async readText(file) {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return undefined;
    }
  },
};

export function nodeEnvironment(): Environment {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    arch: process.arch,
  };
}

/** The folders virtual devices live in, most specific first. */
function avdFolders({ env, home }: Environment) {
  return [
    env.ANDROID_AVD_HOME,
    env.ANDROID_SDK_HOME && path.join(env.ANDROID_SDK_HOME, "avd"),
    env.ANDROID_SDK_HOME && path.join(env.ANDROID_SDK_HOME, ".android", "avd"),
    path.join(home, ".android", "avd"),
  ].filter((folder): folder is string => !!folder);
}

export interface ServiceOptions {
  /** The Settings switches now. */
  switches(): Record<SimulatorKind, boolean>;
  /** The devices the person allowed Claude to use, kept between runs. */
  loadGrants(): string[];
  saveGrants(keys: string[]): void;
  /** Claude's 'launch' started an app. */
  onLaunch?(kind: SimulatorKind, deviceId: string, appId: string): void;
}

/** The service, its drivers and the setup checks over this computer's tools. */
export function createSimulatorService(
  platform: SimulatorPlatform,
  options: ServiceOptions,
): SimulatorService {
  const { environment, probe, runner } = platform;
  const drivers: Partial<Record<SimulatorKind, DeviceDriver>> = {};
  if (environment.platform === "darwin")
    drivers.ios = new IosDriver({
      runner,
      findIdb: () => findIdb(environment, probe),
      isDirectory: (folder) => probe.isDirectory(folder),
    });
  if (environment.platform === "darwin" || environment.platform === "win32")
    drivers.android = new AndroidDriver({
      runner,
      adb: async () => (await findAndroidTools(environment, probe)).adb,
      emulator: async () =>
        (await findAndroidTools(environment, probe)).emulator,
      avdConfig: async (name) => {
        for (const folder of avdFolders(environment)) {
          const text = await probe.readText(
            path.join(folder, `${name}.avd`, "config.ini"),
          );
          if (text !== undefined) return text;
        }
        return undefined;
      },
      isFile: (file) => probe.isFile(file),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
  const consent = new Consent({
    signature: createHash("sha256")
      .update(JSON.stringify(simulatorToolSpecs(["ios", "android"])))
      .digest("hex"),
    ask: (text) => platform.ask(text),
    load: options.loadGrants,
    save: options.saveGrants,
    now: () => Date.now(),
  });
  return new SimulatorService({
    platform: environment.platform,
    drivers,
    scaler: platform.scaler,
    consent,
    switches: options.switches,
    onLaunch: options.onLaunch,
    setup: (kind) =>
      kind === "ios"
        ? checkIosSetup({ environment, probe, runner })
        : checkAndroidSetup({ environment, probe, runner }),
  });
}

/** The control bar's captures, the Device and Edit menus and the logs of the service's devices. */
export function createSimulatorMedia(
  platform: SimulatorPlatform,
  service: SimulatorService,
): SimulatorMedia {
  return new SimulatorMedia({
    driver: (kind, id) => service.paneDriver(kind, id),
    deviceName: (kind, id) => service.deviceName(kind, id),
    runner: platform.runner,
    scaler: platform.scaler,
    files: nodeCaptureFiles(() => platform.captureFolder()),
    clipboard: platform.clipboard,
    thumbnail: platform.thumbnail?.bind(platform),
    reveal: (file) => platform.reveal(file),
    now: () => Date.now(),
  });
}

/** The setup screens' buttons: open Xcode, the App Store, Android Studio or its download page. */
export async function openSimulatorTarget(
  platform: SimulatorPlatform,
  target: SimulatorOpenTarget,
): Promise<boolean> {
  const { environment, probe, runner } = platform;
  try {
    switch (target) {
      case "xcode": {
        if (environment.platform !== "darwin") return false;
        // The Xcode the command-line tools point at, else any named Xcode.
        let app: string | undefined;
        try {
          const developer = (await runner.run("xcode-select", ["-p"])).trim();
          if (developer.endsWith("/Contents/Developer"))
            app = developer.slice(0, -"/Contents/Developer".length);
        } catch {
          /* not selected */
        }
        await runner.run(
          "/usr/bin/open",
          app && app.endsWith(".app") && (await probe.exists(app))
            ? [app]
            : ["-a", "Xcode"],
        );
        return true;
      }
      case "app-store":
        if (environment.platform !== "darwin") return false;
        await runner.run("/usr/bin/open", [
          "macappstore://apps.apple.com/app/xcode/id497799835",
        ]);
        return true;
      case "android-studio": {
        for (const location of androidStudioLocations(environment)) {
          if (!(await probe.exists(location.marker))) continue;
          const [file, ...args] = location.launch;
          if (environment.platform === "win32")
            await runner.startDetached(file, args);
          else await runner.run(file, args);
          return true;
        }
        return false;
      }
      case "download-android-studio":
        await platform.openExternal(androidStudioUrl);
        return true;
    }
  } catch {
    return false;
  }
}
