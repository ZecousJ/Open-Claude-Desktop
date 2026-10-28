/**
 * The Android Emulator through the SDK's `adb` and `emulator` (desktop
 * bundle 2.31226.1 does the same: emulators only, never a physical phone).
 * Every device command is `adb -s <serial> …` with an argument array; what
 * runs on the device is quoted, because adb joins its arguments into one
 * line for the device's shell.
 */
import {
  androidPackagePattern,
  avdNamePattern,
  emulatorSerialPattern,
  type AndroidButton,
  type KeyName,
  type SimulatorDevice,
} from "../../shared/simulators";
import {
  SimulatorError,
  type DeviceDriver,
  type InputSpace,
  type LogStream,
  type TextResult,
  type TouchPoint,
} from "./driver";
import { logCommands, parseLogcatLine } from "./logs";
import { pngSize } from "./png";
import {
  parseUiDump,
  androidKeyCodes,
  androidKeyEvents,
  androidTextInput,
  adbCommands,
  emulatorCommands,
  type RunningEmulator,
  parseAdbDevices,
  parseAvdList,
  parseAvdName,
  parseAvdDisplayName,
  androidBaselineDpi,
  parseDensity,
  type AndroidDeps,
  bootTimeoutMs,
  bootPollMs,
} from "./android-commands";

export class AndroidDriver implements DeviceDriver {
  readonly kind = "android" as const;
  /** AVD names being started, shown as booting until they are up. */
  private starting = new Set<string>();
  /** Serial → AVD name (stays true while the emulator runs). */
  private avdBySerial = new Map<string, string>();
  /** Serial → the screen's density in dpi, read once per running emulator. */
  private densities = new Map<string, number>();
  constructor(private deps: AndroidDeps) {}

  private async adbPath() {
    const adb = await this.deps.adb();
    if (!adb)
      throw new SimulatorError(
        "Couldn't find `adb`. Install Android SDK platform-tools (or set ANDROID_HOME).",
      );
    return adb;
  }

  private async adb(args: string[], timeoutMs = 20_000) {
    return this.deps.runner.run(await this.adbPath(), args, { timeoutMs });
  }

  private async running(): Promise<(RunningEmulator & { avd?: string })[]> {
    const emulators = parseAdbDevices(await this.adb(adbCommands.devices()));
    const live = new Set(emulators.map((item) => item.serial));
    for (const serial of this.avdBySerial.keys())
      if (!live.has(serial)) this.avdBySerial.delete(serial);
    for (const serial of this.densities.keys())
      if (!live.has(serial)) this.densities.delete(serial);
    return Promise.all(
      emulators.map(async (item) => {
        let avd = this.avdBySerial.get(item.serial);
        if (!avd && item.state === "device") {
          try {
            avd = parseAvdName(
              await this.adb(adbCommands.avdName(item.serial)),
            );
          } catch {
            /* the console is not ready yet */
          }
          if (avd) this.avdBySerial.set(item.serial, avd);
        }
        return { ...item, avd };
      }),
    );
  }

  private async avds(): Promise<string[]> {
    const emulator = await this.deps.emulator();
    if (!emulator) return [];
    return parseAvdList(
      await this.deps.runner.run(emulator, emulatorCommands.listAvds(), {
        timeoutMs: 15_000,
      }),
    );
  }

  private async displayName(avd: string) {
    const config = await this.deps.avdConfig(avd).catch(() => undefined);
    return (config && parseAvdDisplayName(config)) || avd;
  }

  async list(): Promise<SimulatorDevice[]> {
    const [running, names] = await Promise.all([
      this.running(),
      this.avds().catch(() => [] as string[]),
    ]);
    const devices: SimulatorDevice[] = [];
    const used = new Set<string>();
    for (const item of running) {
      if (item.avd) used.add(item.avd);
      devices.push({
        kind: "android",
        id: item.serial,
        name: await this.displayName(item.avd ?? item.serial),
        state: item.state === "device" ? "booted" : "booting",
        ...(item.avd ? { avd: item.avd } : {}),
      });
    }
    for (const avd of names) {
      if (used.has(avd)) continue;
      devices.push({
        kind: "android",
        id: avd,
        name: await this.displayName(avd),
        state: this.starting.has(avd) ? "booting" : "shutdown",
        avd,
      });
    }
    return devices;
  }

  /** The running emulator for an id: a serial, or a virtual device that is up. */
  private async serialOf(id: string): Promise<string> {
    if (emulatorSerialPattern.test(id)) {
      if (!(await this.running()).some((item) => item.serial === id))
        throw new SimulatorError(`${id} is not running.`);
      return id;
    }
    const found = (await this.running()).find((item) => item.avd === id);
    if (!found) throw new SimulatorError(`${id} is not running.`);
    return found.serial;
  }

  async boot(id: string): Promise<SimulatorDevice> {
    if (emulatorSerialPattern.test(id) || (await this.isUp(id))) {
      const serial = await this.serialOf(id);
      return this.deviceOf(serial);
    }
    if (!avdNamePattern.test(id))
      throw new SimulatorError(
        `${id.slice(0, 80)} is not an Android emulator.`,
      );
    const emulator = await this.deps.emulator();
    if (!emulator)
      throw new SimulatorError(
        "Android emulator launcher not found. Install the Android SDK emulator (or set ANDROID_HOME), or start a device manually.",
      );
    const names = await this.avds();
    if (!names.includes(id))
      throw new SimulatorError(
        `No AVD named '${id}'.${
          names.length
            ? ` Available AVDs: ${names.join(", ")}.`
            : " Create one in Android Studio's Device Manager."
        } Physical devices are not supported; only Android emulators can be used.`,
      );
    const before = new Set((await this.running()).map((item) => item.serial));
    this.starting.add(id);
    try {
      await this.deps.runner.startDetached(
        emulator,
        emulatorCommands.start(id),
      );
      const until = this.deps.now() + bootTimeoutMs;
      while (this.deps.now() < until) {
        await this.deps.sleep(bootPollMs);
        for (const item of await this.running()) {
          if (before.has(item.serial) || item.avd !== id) continue;
          const done = (
            await this.adb(adbCommands.bootCompleted(item.serial)).catch(
              () => "",
            )
          ).trim();
          if (done === "1") return this.deviceOf(item.serial);
        }
      }
    } finally {
      this.starting.delete(id);
    }
    throw new SimulatorError(
      `Failed to boot the device: Emulator '${id}' did not finish booting within ${bootTimeoutMs / 1000}s. It may still be booting. Try attaching again in a minute.`,
    );
  }

  private async isUp(avd: string) {
    return (await this.running()).some((item) => item.avd === avd);
  }

  private async deviceOf(serial: string): Promise<SimulatorDevice> {
    const device = (await this.list()).find((item) => item.id === serial);
    if (!device) throw new SimulatorError("The emulator is no longer listed.");
    return device;
  }

  async shutdown(id: string) {
    if (!emulatorSerialPattern.test(id) && !(await this.isUp(id))) return;
    await this.adb(adbCommands.kill(await this.serialOf(id)), 30_000);
  }

  async screenshot(id: string) {
    return this.deps.runner.runBinary(
      await this.adbPath(),
      adbCommands.screenshot(await this.serialOf(id)),
      { timeoutMs: 20_000 },
    );
  }

  /** The screen's density over Android's baseline 160 dpi (one dp). */
  async pixelsPerPoint(id: string) {
    const serial = await this.serialOf(id);
    const known = this.densities.get(serial);
    if (known) return known / androidBaselineDpi;
    const dpi = parseDensity(await this.adb(adbCommands.density(serial)));
    if (dpi === undefined) return undefined;
    this.densities.set(serial, dpi);
    return dpi / androidBaselineDpi;
  }

  async inputAvailable() {
    return (await this.deps.adb()) !== undefined;
  }

  async inputSpace(
    id: string,
    screenshot?: Buffer,
  ): Promise<InputSpace | undefined> {
    return pngSize(screenshot ?? (await this.screenshot(id)));
  }

  async tap(id: string, x: number, y: number, durationSec?: number) {
    const serial = await this.serialOf(id);
    if (durationSec !== undefined && durationSec > 0) {
      const ms = Math.min(durationSec, 30) * 1000;
      await this.adb(
        adbCommands.swipe(serial, { x, y }, { x, y }, ms),
        ms + 20_000,
      );
    } else await this.adb(adbCommands.tap(serial, x, y));
  }

  async swipe(
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationSec: number,
  ) {
    const ms = Math.min(Math.max(durationSec, 0.05), 30) * 1000;
    await this.adb(
      adbCommands.swipe(await this.serialOf(id), from, to, ms),
      ms + 20_000,
    );
  }

  /** `input motionevent` (Android 10 and later): down, each move after its wait, up. */
  async touchPath(id: string, points: TouchPoint[]) {
    const serial = await this.serialOf(id);
    const last = points[points.length - 1];
    try {
      await this.adb(
        adbCommands.motion(serial, "DOWN", points[0].x, points[0].y),
      );
      for (const point of points.slice(1)) {
        if (point.dtMs > 0) await this.deps.sleep(point.dtMs);
        await this.adb(adbCommands.motion(serial, "MOVE", point.x, point.y));
      }
    } finally {
      await this.adb(adbCommands.motion(serial, "UP", last.x, last.y)).catch(
        () => undefined,
      );
    }
  }

  async text(id: string, value: string): Promise<TextResult> {
    const serial = await this.serialOf(id);
    const { chunks, typed, dropped } = androidTextInput(value);
    for (const chunk of chunks) await this.adb(adbCommands.text(serial, chunk));
    return { typed, dropped };
  }

  async button(id: string, name: string) {
    const code = androidKeyCodes[name as AndroidButton];
    if (code === undefined)
      throw new SimulatorError(`Android has no ${name} button.`);
    await this.adb(adbCommands.key(await this.serialOf(id), code));
  }

  async key(id: string, name: KeyName) {
    await this.adb(
      adbCommands.key(await this.serialOf(id), androidKeyEvents[name]),
    );
  }

  async openUrl(id: string, url: string) {
    await this.adb(adbCommands.openUrl(await this.serialOf(id), url));
  }

  async launch(id: string, appPath: string, appId?: string) {
    if (!appId || !androidPackagePattern.test(appId))
      throw new SimulatorError(
        "'launch' requires bundle_id (Android package id, e.g. com.example.app).",
      );
    if (!/\.apk$/i.test(appPath) || !(await this.deps.isFile(appPath)))
      throw new SimulatorError("app_path must be an existing .apk file.");
    const serial = await this.serialOf(id);
    await this.adb(adbCommands.install(serial, appPath), 120_000);
    const output = await this.adb(adbCommands.start(serial, appId), 30_000);
    if (/monkey aborted/i.test(output))
      throw new SimulatorError(
        `${appId} could not be launched${
          /No activities found/i.test(output)
            ? " (no launchable activity; is this the APK's package id?)"
            : ""
        }.`,
      );
    return { appId };
  }

  /** Device → Show on-screen keyboard: reads the setting, or sets it first. */
  async softwareKeyboard(id: string, show?: boolean) {
    const serial = await this.serialOf(id);
    if (show !== undefined)
      await this.adb(adbCommands.softKeyboard(serial, show));
    const now = (await this.adb(adbCommands.softKeyboard(serial))).trim();
    return now === "1";
  }

  async elements(id: string) {
    const serial = await this.serialOf(id);
    const xml = await this.adb(adbCommands.uiDump(serial), 30_000);
    const elements = parseUiDump(xml);
    const root = elements[0]?.frame;
    if (!root)
      throw new SimulatorError(
        "The emulator's screen couldn't be read. Try again.",
      );
    return {
      elements,
      space: { width: root.x + root.width, height: root.y + root.height },
    };
  }

  /**
   * A foldable emulator's hinge angle in degrees (0 closed to 180 flat),
   * after setting it when `degrees` is given; null for a device that has
   * no hinge.
   */
  async hinge(id: string, degrees?: number) {
    const serial = await this.serialOf(id);
    if (degrees !== undefined)
      await this.adb(
        adbCommands.hinge(serial, Math.min(180, Math.max(0, degrees))),
      );
    let answer: string;
    try {
      answer = await this.adb(adbCommands.hinge(serial));
    } catch {
      return null;
    }
    const match = /hinge-angle0\s*[=:]\s*(-?[\d.]+)/.exec(answer);
    return match ? Number(match[1]) : null;
  }

  /**
   * Claude's airplane_mode; whether it is on afterwards. Throws when the
   * emulator can't say (before Android 10).
   */
  async airplaneMode(id: string, on?: boolean) {
    const serial = await this.serialOf(id);
    const read = async () => {
      const answer = (await this.adb(adbCommands.airplaneMode(serial))).trim();
      if (answer !== "enabled" && answer !== "disabled")
        throw new SimulatorError(
          "Couldn't read airplane mode on the emulator, so its network was left as it was. Switching it works on Android 10 (API 29) and later.",
        );
      return answer === "enabled";
    };
    if (on === undefined) return read();
    await this.adb(adbCommands.airplaneMode(serial, on));
    const now = await read();
    if (now !== on)
      throw new SimulatorError(
        `Airplane mode on the emulator did not turn ${on ? "on" : "off"}.`,
      );
    return now;
  }

  /**
   * Device → Slow animations: the window, transition and animator scales
   * at 10× (on) or 1× (off); reads the animator scale, or sets all three first.
   */
  async slowAnimations(id: string, on?: boolean) {
    const serial = await this.serialOf(id);
    if (on !== undefined)
      for (const setting of [
        "window_animation_scale",
        "transition_animation_scale",
        "animator_duration_scale",
      ])
        await this.adb(
          adbCommands.animationScale(serial, setting, on ? 10 : 1),
        );
    const now = Number(
      (
        await this.adb(
          adbCommands.animationScale(serial, "animator_duration_scale"),
        )
      ).trim(),
    );
    return Number.isFinite(now) && now > 1;
  }

  async logStream(id: string): Promise<LogStream> {
    return {
      file: await this.adbPath(),
      args: logCommands.android(await this.serialOf(id)),
      parse: parseLogcatLine,
    };
  }
}
