/**
 * The iOS Simulator through `xcrun simctl` (list, boot, shut down, screenshots,
 * install, launch, open a link) and, for touch input, Facebook's `idb`: the
 * simulator has no command line for taps, swipes, typing or buttons, and the
 * original does it with a helper that talks to Apple's private frameworks.
 * Without idb Claudex still lists, boots and shows the device and says what
 * is missing when something asks for input.
 *
 * Builders and parsers are plain functions so tests can check them; the
 * driver only wires them to a `Runner`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bundleIdPattern,
  type IosButton,
  type SimulatorEditAction,
  type KeyName,
  type SimulatorAppearance,
} from "../../shared/simulators";
import {
  SimulatorError,
  type DeviceDriver,
  type InputSpace,
  type LogStream,
  type TextResult,
  type TouchPoint,
} from "./driver";
import { logCommands, parseIosLogLine } from "./logs";
import { pngSize } from "./png";
import { CommandError, within } from "./runner";
import {
  iosKeyCodes,
  iosCommands,
  recordingSettleMs,
  idbCommands,
  simulatorShortcutScript,
  parseSimctlDevices,
  parseIdbElements,
  parseIdbSpace,
  pixelRatio,
  alreadyBooted,
  type IosDeps,
  bootTimeoutMs,
} from "./ios-commands";

export class IosDriver implements DeviceDriver {
  readonly kind = "ios" as const;
  /** Device sizes idb reported, by UDID. */
  private spaces = new Map<string, InputSpace>();
  constructor(private deps: IosDeps) {}

  private xcrun(args: string[], timeoutMs?: number) {
    return this.deps.runner.run("xcrun", args, { timeoutMs });
  }

  private async simulatorUi(id: string, script: string) {
    await this.deps.runner.run("open", [
      "-g",
      "-a",
      "Simulator",
      "--args",
      "-CurrentDeviceUDID",
      id,
    ]);
    await this.deps.runner.run("/usr/bin/osascript", ["-e", script], {
      timeoutMs: 20_000,
    });
  }

  rotate(id: string) {
    this.spaces.delete(id);
    return this.simulatorUi(id, simulatorShortcutScript(124));
  }

  edit(id: string, action: SimulatorEditAction) {
    const codes = { undo: 6, redo: 6, cut: 7, copy: 8, paste: 9, selectAll: 0 };
    return this.simulatorUi(
      id,
      simulatorShortcutScript(codes[action], action === "redo"),
    );
  }

  async softwareKeyboard(id: string, show?: boolean) {
    let visible = true;
    try {
      const value = await this.xcrun([
        "simctl",
        "spawn",
        id,
        "defaults",
        "read",
        "com.apple.keyboard.preferences",
        "AutomaticMinimizationEnabled",
      ]);
      visible = value.trim() !== "1";
    } catch (error) {
      if (!/does not exist|Could not find key/i.test(String(error)))
        throw error;
    }
    if (show !== undefined && show !== visible) {
      await this.simulatorUi(id, simulatorShortcutScript(40));
      return show;
    }
    return visible;
  }

  async slowAnimations(id: string, on?: boolean) {
    const notification = "com.apple.UIKit.SimulatorSlowMotionAnimationState";
    const args = ["simctl", "spawn", id, "notifyutil"];
    if (on !== undefined)
      await this.xcrun([
        ...args,
        "-s",
        notification,
        on ? "1" : "0",
        "-p",
        notification,
      ]);
    const value = await this.xcrun([...args, "-g", notification]);
    const [name, state, ...extra] = value.trim().split(/\s+/);
    if (name !== notification || !/^\d+$/.test(state ?? "") || extra.length)
      throw new SimulatorError(
        "Couldn’t change the animation speed. Try again.",
      );
    return Number(state) !== 0;
  }

  async list() {
    return parseSimctlDevices(await this.xcrun(iosCommands.list(), 20_000));
  }

  async boot(id: string) {
    try {
      await this.xcrun(iosCommands.boot(id), 60_000);
    } catch (error) {
      if (!alreadyBooted(error)) throw error;
    }
    await this.xcrun(iosCommands.bootStatus(id), bootTimeoutMs);
    const device = (await this.list()).find((item) => item.id === id);
    if (!device) throw new SimulatorError("The simulator is no longer listed.");
    return device;
  }

  async rename(id: string, name: string) {
    await this.xcrun(iosCommands.rename(id, name), 30_000);
  }

  async shutdown(id: string) {
    try {
      await this.xcrun(iosCommands.shutdown(id), 60_000);
    } catch (error) {
      // Already off.
      if (!(
        error instanceof CommandError &&
        /current state: Shutdown/i.test(error.stderr)
      ))
        throw error;
    }
    this.spaces.delete(id);
  }

  /**
   * A PNG of the screen, written to a private temporary file and read back:
   * Xcode 27's simctl writes "-" as a file of that name in the working
   * folder instead of to standard output, and refuses /dev/stdout.
   */
  async screenshot(id: string) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-sim-"));
    const file = path.join(folder, "screen.png");
    try {
      await this.xcrun(iosCommands.screenshot(id, file), 20_000);
      return await fs.readFile(file);
    } finally {
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  async inputAvailable() {
    return (await this.deps.findIdb()) !== undefined;
  }

  async inputSpace(id: string) {
    const known = this.spaces.get(id);
    if (known) return known;
    const idb = await this.deps.findIdb();
    if (!idb) return undefined;
    try {
      const space = parseIdbSpace(
        await this.deps.runner.run(idb, idbCommands.describe(id), {
          timeoutMs: 20_000,
        }),
      );
      if (space) this.spaces.set(id, space);
      return space;
    } catch {
      return undefined;
    }
  }

  /** The screenshot's pixels per point: its longer edge over the size idb reports. */
  async pixelsPerPoint(id: string, screenshot: Buffer) {
    const size = pngSize(screenshot);
    const space = await this.inputSpace(id);
    if (!size || !space) return undefined;
    return pixelRatio(size, space);
  }

  async elements(id: string) {
    const idb = await this.deps.findIdb();
    if (!idb)
      throw new SimulatorError(
        "The inspector needs Facebook idb to read the simulator's accessibility elements. Install it with `brew tap facebook/fb && brew install idb-companion` and `pip3 install fb-idb`.",
      );
    const space = await this.inputSpace(id);
    if (!space)
      throw new SimulatorError(
        "The simulator's size in points couldn't be read.",
      );
    const elements = parseIdbElements(
      await this.deps.runner.run(idb, idbCommands.describeAll(id), {
        timeoutMs: 20_000,
      }),
    );
    return { elements, space };
  }

  /** idb, or an error that says how to get it. */
  private async idb(args: string[], timeoutMs = 20_000) {
    const idb = await this.deps.findIdb();
    if (!idb)
      throw new SimulatorError(
        "Tapping, swiping and typing in the iOS Simulator need Facebook idb, which isn't installed. Install it with `brew tap facebook/fb && brew install idb-companion` and `pip3 install fb-idb`. Screenshots, booting, installing and opening links work without it.",
      );
    await this.deps.runner.run(idb, args, { timeoutMs });
  }

  tap(id: string, x: number, y: number, durationSec?: number) {
    return this.idb(idbCommands.tap(id, x, y, durationSec));
  }

  swipe(
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationSec: number,
  ) {
    return this.idb(
      idbCommands.swipe(id, from, to, durationSec),
      30_000 + durationSec * 1000,
    );
  }

  /** idb can't follow a path: the drag goes from the first sample to the last over the same time. */
  touchPath(id: string, points: TouchPoint[]) {
    const first = points[0];
    const last = points[points.length - 1];
    const total = points.reduce((sum, point) => sum + point.dtMs, 0);
    return this.swipe(id, first, last, Math.max(total / 1000, 0.1));
  }

  async text(id: string, value: string): Promise<TextResult> {
    await this.idb(idbCommands.text(id, value), 30_000);
    return { typed: value.length, dropped: 0 };
  }

  button(id: string, name: string) {
    return this.idb(idbCommands.button(id, name as IosButton));
  }

  key(id: string, name: KeyName) {
    return this.idb(idbCommands.key(id, iosKeyCodes[name]));
  }

  async openUrl(id: string, url: string) {
    await this.xcrun(iosCommands.openUrl(id, url));
  }

  async appearance(id: string, set?: SimulatorAppearance) {
    // Answers can take a while on a busy simulator (the original allows 35 s).
    if (set) await this.xcrun(iosCommands.appearance(id, set), 35_000);
    const now = (await this.xcrun(iosCommands.appearance(id), 35_000)).trim();
    return now === "light" || now === "dark" ? now : null;
  }

  async readPasteboard(id: string) {
    return this.xcrun(iosCommands.pbpaste(id), 10_000);
  }

  async writePasteboard(id: string, text: string) {
    await this.deps.runner.run("xcrun", iosCommands.pbcopy(id), {
      timeoutMs: 10_000,
      input: text,
    });
  }

  /** Starts `simctl io recordVideo`; an early exit (another recording, a bad device) is an error. */
  async record(id: string, file: string) {
    const process = this.deps.runner.start(
      "xcrun",
      iosCommands.recordVideo(id, file),
    );
    const early = await within(
      process.exited.then(() => true),
      recordingSettleMs,
      false,
    );
    if (early) {
      const said = process.stderr().trim().split("\n").slice(-2).join(" ");
      throw new SimulatorError(
        /already|in progress|busy/i.test(said)
          ? "Couldn’t start the recording because the simulator already has a recording in progress. Stop any other recording, or restart the simulator, then try again."
          : `Couldn’t start the recording.${said ? ` ${said.slice(0, 300)}` : ""}`,
      );
    }
    return process;
  }

  async logStream(id: string): Promise<LogStream> {
    return {
      file: "xcrun",
      args: logCommands.ios(id),
      parse: parseIosLogLine,
    };
  }

  /** The bundle identifier in an app's Info.plist. */
  async bundleIdOf(appPath: string) {
    const text = await this.deps.runner.run("plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Info.plist"),
    ]);
    return text.trim();
  }

  async launch(id: string, appPath: string, appId?: string) {
    const app = path.resolve(appPath);
    if (!/\.app$/i.test(app) || !(await this.deps.isDirectory(app)))
      throw new SimulatorError(
        "app_path must be a built .app bundle (a folder ending in .app).",
      );
    const bundleId = appId ?? (await this.bundleIdOf(app));
    if (!bundleIdPattern.test(bundleId))
      throw new SimulatorError(
        `Not a bundle identifier: ${bundleId.slice(0, 80)}`,
      );
    await this.xcrun(iosCommands.install(id, app), 120_000);
    await this.xcrun(iosCommands.launch(id, bundleId), 60_000);
    return { appId: bundleId };
  }
}
