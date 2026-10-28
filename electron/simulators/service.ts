/**
 * The simulators the signed-in account can use: the pane's calls (list,
 * boot, shut down, show the screen, a person's taps) and the device tool
 * Claude calls (`control`: attach, launch, screenshot, tap, swipe, text,
 * button, open_url, detach). Both go through the drivers (`ios.ts`,
 * `android.ts`); only Claude's calls ask the person first (`consent.ts`).
 *
 * Coordinates Claude gives are in its screenshots' space: iOS screenshots
 * are scaled to the device's size in points, as the original reports it, and
 * Android ones keep the device's pixels (scaled down when large, mapped back
 * here).
 */
import {
  deviceNameProblem,
  setupReady,
  simulatorNoun,
  simulatorSupported,
  simulatorTextLimit,
  validDeviceId,
  type AndroidSetupStatus,
  type IosSetupStatus,
  type SimulatorDevice,
  type SimulatorElement,
  type SimulatorInput,
  type SimulatorKind,
  type SimulatorScreen,
  type SimulatorsState,
} from "../../shared/simulators";
import type { Consent } from "./consent";
import { SimulatorError, type DeviceDriver, type InputSpace } from "./driver";
import { pngSize, type ImageScaler, type ScaledImage } from "./png";
import {
  setupFreshMs,
  setupRecheckMs,
  paneImageEdge,
  densityRetryMs,
  fitWithin,
  dataUrl,
} from "./service-support";
import * as serviceAccess from "./service-access";
import { installMethods } from "./install-methods";
import * as serviceControl from "./service-control";

export interface ServiceDeps {
  platform: string;
  drivers: Partial<Record<SimulatorKind, DeviceDriver>>;
  scaler: ImageScaler;
  consent: Consent;
  /** The Settings switches now. */
  switches(): Record<SimulatorKind, boolean>;
  /** The setup check of a kind. */
  setup(kind: SimulatorKind): Promise<IosSetupStatus | AndroidSetupStatus>;
  /** Claude's 'launch' started an app (the logs tool starts capturing it). */
  onLaunch?(kind: SimulatorKind, deviceId: string, appId: string): void;
}

/** What Claude's `control` call is given (checked by the tool's schema). */
export interface ControlArgs {
  action: string;
  device?: string;
  app_path?: string;
  bundle_id?: string;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  duration?: number;
  text?: string;
  name?: string;
  url?: string;
  points?: { x: number; y: number; dt_ms?: number }[];
  /** For 'airplane_mode': "on" or "off". */
  state?: "on" | "off";
}

export type ControlPart =
  { type: "text"; text: string } | { type: "image"; image: ScaledImage };

export interface ControlResult {
  success: boolean;
  parts: ControlPart[];
}

/** What a screenshot sent to Claude measured, to map its coordinates back. */
interface View {
  /** The space taps go to (iOS points, Android pixels). */
  space: InputSpace;
  /** The picture Claude saw. */
  image: InputSpace;
}

export class SimulatorService {
  autoConversations = new Set<string>();
  autoNotices = new Set<string>();
  /** The device each conversation is using, by kind: the consent key's device part. */
  current = new Map<string, string>();
  views = new Map<string, View>();
  private setups = new Map<
    SimulatorKind,
    { at: number; status: IosSetupStatus | AndroidSetupStatus }
  >();
  /** The latest size of a device's screenshot, for the pane's taps. */
  shots = new Map<string, InputSpace>();
  /** What each device said about its pixels per point, and when. */
  densities = new Map<string, { at: number; ratio?: number }>();
  /** Emulators Claude put in airplane mode ("kind:id"), switched back off when let go of. */
  airplaneOn = new Set<string>();
  constructor(public deps: ServiceDeps) {}

  /** Turns airplane mode back off on a device Claude turned it on for. */
  async restoreNetwork(kind: SimulatorKind, id: string) {
    const key = `${kind}:${id}`;
    if (!this.airplaneOn.delete(key)) return;
    await this.driver(kind)
      .airplaneMode?.(id, false)
      .catch(() => undefined);
  }

  // -- The pane --------------------------------------------------------------

  state(): SimulatorsState {
    const switches = this.deps.switches();
    const of = (kind: SimulatorKind) => ({
      supported: simulatorSupported(kind, this.deps.platform),
      enabled: switches[kind],
    });
    const platform = this.deps.platform;
    return {
      platform:
        platform === "darwin" || platform === "win32" ? platform : "linux",
      ios: of("ios"),
      android: of("android"),
    };
  }

  /** The setup check, run again (the setup screens poll it while a step is open). */
  async setup(kind: SimulatorKind) {
    const status = await this.deps.setup(kind);
    this.setups.set(kind, { at: Date.now(), status });
    return status;
  }

  /** The last check when it is recent, else a new one (Claude's calls come often). */
  async setupCached(kind: SimulatorKind) {
    const known = this.setups.get(kind);
    if (known && Date.now() - known.at < setupFreshMs) return known.status;
    return this.setup(kind);
  }

  /** Whether the last check found everything the kind needs (the tools are offered then). */
  ready(kind: SimulatorKind) {
    const known = this.setups.get(kind);
    // Checked again in the background once a minute, so a change in Settings
    // or an install shows up by the next thread.
    if (!known || Date.now() - known.at > setupRecheckMs)
      void this.setup(kind).catch(() => undefined);
    return known !== undefined && setupReady(kind, known.status);
  }

  driver(kind: SimulatorKind): DeviceDriver {
    const driver = this.deps.drivers[kind];
    if (!driver || !simulatorSupported(kind, this.deps.platform))
      throw new SimulatorError(
        kind === "ios"
          ? "Claudex Code iOS Simulator requires macOS."
          : "Claudex Code Android Emulator is not supported on this platform.",
      );
    return driver;
  }

  checkId(kind: SimulatorKind, id: string) {
    if (!validDeviceId(kind, id))
      throw new SimulatorError(`Invalid device ID format: ${id.slice(0, 80)}`);
  }

  /**
   * The driver for a device the pane names, after checking the id (the
   * control bar's captures, menus and logs, `media.ts`).
   */
  paneDriver(kind: SimulatorKind, id: string): DeviceDriver {
    this.checkId(kind, id);
    return this.driver(kind);
  }

  /** A device's name as the picker shows it, for capture file names. */
  async deviceName(kind: SimulatorKind, id: string) {
    const device = (await this.driver(kind).list()).find(
      (item) => item.id === id || item.avd === id,
    );
    return device?.name ?? id;
  }

  async devices(kind: SimulatorKind) {
    return this.driver(kind).list();
  }

  async boot(kind: SimulatorKind, id: string) {
    this.checkId(kind, id);
    await this.driver(kind).boot(id);
  }

  async shutdown(kind: SimulatorKind, id: string) {
    this.checkId(kind, id);
    await this.driver(kind).shutdown(id);
    this.forgetDevice(kind, id);
  }

  /**
   * Restart (the device row's action): shuts the device down and boots it
   * again; an emulator comes back under a new serial, which is returned.
   */
  async restart(kind: SimulatorKind, id: string): Promise<string> {
    this.checkId(kind, id);
    const driver = this.driver(kind);
    const before = (await driver.list()).find(
      (item) => item.id === id || item.avd === id,
    );
    if (!before)
      throw new SimulatorError(
        `The ${kind === "android" ? "emulator" : "simulator"} is no longer listed.`,
      );
    await driver.shutdown(id);
    this.forgetDevice(kind, id);
    const bootId = kind === "android" ? (before.avd ?? id) : id;
    for (let i = 0; i < 40; i++) {
      const now = (await driver.list()).find(
        (item) => item.id === bootId || item.avd === bootId,
      );
      if (!now || now.state === "shutdown") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const after = await driver.boot(bootId);
    return after.id;
  }

  /**
   * Where Claude's build goes: the simulator named (by name or UDID), else
   * the one this conversation uses, else the first booted one, else the
   * generic iOS Simulator platform.
   */
  async buildDestination(conversationId: string, device?: string) {
    const list = await this.driver("ios").list();
    let found: SimulatorDevice | undefined;
    if (device) {
      found = list.find((item) => item.id === device || item.name === device);
      if (!found)
        throw new SimulatorError(
          `No simulator is named ${device.slice(0, 80)}.`,
        );
    } else {
      const held = this.current.get(`${conversationId}:ios`);
      found =
        list.find((item) => item.id === held) ??
        list.find((item) => item.state === "booted");
    }
    return found
      ? `platform=iOS Simulator,id=${found.id}`
      : "generic/platform=iOS Simulator";
  }

  /**
   * The booted device a logs call is about: the one named, else the one
   * this conversation uses, else the first booted one.
   */
  async bootedDevice(
    kind: SimulatorKind,
    conversationId: string,
    device?: string,
  ) {
    const list = await this.driver(kind).list();
    const booted = list.filter((item) => item.state === "booted");
    if (device) {
      const found = booted.find(
        (item) =>
          item.id === device || item.name === device || item.avd === device,
      );
      if (!found)
        throw new SimulatorError(
          `No booted ${simulatorNoun[kind]} is named ${device.slice(0, 80)}.`,
        );
      return found;
    }
    const held = this.current.get(`${conversationId}:${kind}`);
    const found =
      booted.find((item) => item.id === held || item.avd === held) ?? booted[0];
    if (!found)
      throw new SimulatorError(`No ${simulatorNoun[kind]} is booted.`);
    return found;
  }

  /**
   * Inspect: the screen's elements, frames in fractions of the screen,
   * back to front (the pane draws them over the picture at any zoom).
   */
  async inspect(kind: SimulatorKind, id: string): Promise<SimulatorElement[]> {
    this.checkId(kind, id);
    const driver = this.driver(kind);
    if (!driver.elements)
      throw new SimulatorError("This device's elements can't be read here.");
    const { elements, space } = await driver.elements(id);
    return elements
      .map((element, index) => ({
        ...element,
        path: String(index),
        bounds: element.frame,
        frame: {
          x: element.frame.x / space.width,
          y: element.frame.y / space.height,
          width: element.frame.width / space.width,
          height: element.frame.height / space.height,
        },
      }))
      .filter((element) => element.frame.width > 0 && element.frame.height > 0);
  }

  /** Rename… (iOS): the name as `simctl rename` takes it, checked first. */
  async rename(kind: SimulatorKind, id: string, name: string) {
    this.checkId(kind, id);
    const driver = this.driver(kind);
    if (!driver.rename)
      throw new SimulatorError("This device can't be renamed here.");
    const problem = deviceNameProblem(name.trim());
    if (problem) throw new SimulatorError(problem);
    await driver.rename(id, name.trim());
  }

  /** One picture for the pane, scaled to `paneImageEdge`. */
  async screen(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorScreen | null> {
    this.checkId(kind, id);
    try {
      const png = await this.driver(kind).screenshot(id);
      const size = pngSize(png);
      if (!size) return null;
      this.shots.set(`${kind}:${id}`, size);
      const picture = this.deps.scaler(png, fitWithin(size, paneImageEdge));
      const ratio = await this.pixelsPerPoint(kind, id, png);
      return {
        dataUrl: dataUrl(picture),
        width: picture.width,
        height: picture.height,
        deviceWidth: size.width,
        deviceHeight: size.height,
        ...(ratio ? { pixelsPerPoint: ratio } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * A device's pixels per point for the pane's Physical size, asked of the
   * driver once and again after `densityRetryMs` while it has no answer
   * (installing idb gives the iOS one).
   */
  private async pixelsPerPoint(kind: SimulatorKind, id: string, png: Buffer) {
    const key = `${kind}:${id}`;
    const known = this.densities.get(key);
    if (known && (known.ratio || Date.now() - known.at < densityRetryMs))
      return known.ratio;
    let ratio: number | undefined;
    try {
      ratio = await this.driver(kind).pixelsPerPoint?.(id, png);
    } catch {
      ratio = undefined;
    }
    this.densities.set(key, { at: Date.now(), ratio });
    return ratio;
  }

  /** The space taps are given in, for a person's input. */
  private async spaceOf(kind: SimulatorKind, id: string): Promise<InputSpace> {
    const driver = this.driver(kind);
    const space =
      kind === "android"
        ? (this.shots.get(`${kind}:${id}`) ?? (await driver.inputSpace(id)))
        : await driver.inputSpace(id);
    if (!space)
      throw new SimulatorError(
        "Tapping, swiping and typing in the iOS Simulator need Facebook idb, which isn't installed.",
      );
    return space;
  }

  /** A tap, swipe, text or button the person made on the pane. */
  async input(kind: SimulatorKind, id: string, input: SimulatorInput) {
    this.checkId(kind, id);
    const driver = this.driver(kind);
    const fraction = (value: number) =>
      Number.isFinite(value) && value >= 0 && value <= 1;
    switch (input.type) {
      case "rotate":
        if (!driver.rotate)
          throw new SimulatorError("Rotation is not supported by this device.");
        return driver.rotate(id);
      case "edit":
        if (!driver.edit)
          throw new SimulatorError("Editing is not supported by this device.");
        return driver.edit(id, input.action);
      case "tap": {
        if (!fraction(input.x) || !fraction(input.y))
          throw new SimulatorError("The tap is outside the screen.");
        const space = await this.spaceOf(kind, id);
        return driver.tap(
          id,
          input.x * space.width,
          input.y * space.height,
          input.duration,
        );
      }
      case "swipe": {
        if (![input.x, input.y, input.x2, input.y2].every(fraction))
          throw new SimulatorError("The swipe is outside the screen.");
        const space = await this.spaceOf(kind, id);
        return driver.swipe(
          id,
          { x: input.x * space.width, y: input.y * space.height },
          { x: input.x2 * space.width, y: input.y2 * space.height },
          input.duration ?? 0.3,
        );
      }
      case "text":
        await driver.text(id, input.value.slice(0, simulatorTextLimit));
        return;
      case "button":
        return driver.button(id, input.name);
      case "key":
        return driver.key(id, input.name);
    }
  }

  // -- Consent ---------------------------------------------------------------

  approveTools() {
    return this.deps.consent.ensureTools();
  }

  permissionMode(conversationId: string, auto: boolean) {
    if (auto) this.autoConversations.add(conversationId);
    else this.autoConversations.delete(conversationId);
  }
}

export interface SimulatorService {
  look: OmitThisParameter<typeof serviceControl.look>;
  viewOf: OmitThisParameter<typeof serviceControl.viewOf>;
  spaceNote: OmitThisParameter<typeof serviceControl.spaceNote>;
  toDevice: OmitThisParameter<typeof serviceControl.toDevice>;
  control: OmitThisParameter<typeof serviceControl.control>;
  perform: OmitThisParameter<typeof serviceControl.perform>;
}
installMethods(SimulatorService.prototype, serviceControl);

export interface SimulatorService {
  keyOf: OmitThisParameter<typeof serviceAccess.keyOf>;
  hasAccess: OmitThisParameter<typeof serviceAccess.hasAccess>;
  allow: OmitThisParameter<typeof serviceAccess.allow>;
  forget: OmitThisParameter<typeof serviceAccess.forget>;
  forgetDevice: OmitThisParameter<typeof serviceAccess.forgetDevice>;
  unavailable: OmitThisParameter<typeof serviceAccess.unavailable>;
  resolve: OmitThisParameter<typeof serviceAccess.resolve>;
  ensureAccess: OmitThisParameter<typeof serviceAccess.ensureAccess>;
}
installMethods(SimulatorService.prototype, serviceAccess);
