import test from "node:test";
import assert from "node:assert/strict";
import {
  Consent,
  declinedCooldownMs,
  type DialogAnswer,
} from "../../electron/simulators/consent";
import {
  SimulatorError,
  type DeviceDriver,
  type InputSpace,
  type TouchPoint,
} from "../../electron/simulators/driver";
import { SimulatorService } from "../../electron/simulators/service";
import {
  fitWithin,
  setupProblem,
} from "../../electron/simulators/service-support";
import {
  consentKey,
  consentText,
  deviceLabel,
  type IosSetupStatus,
  type SimulatorDevice,
  type SimulatorKind,
} from "../../shared/simulators";
import { fakeScaler, png } from "../support/simulators-fakes";

const udid = "33333333-3333-3333-3333-333333333333";
const phone: SimulatorDevice = {
  kind: "ios",
  id: udid,
  name: "iPhone 17",
  state: "booted",
  osVersion: "iOS 27.0",
};
const sleeping: SimulatorDevice = {
  kind: "ios",
  id: "22222222-2222-2222-2222-222222222222",
  name: "iPhone 18 Pro",
  state: "shutdown",
  osVersion: "iOS 27.0",
};

/** A driver that records what it was asked and shows a fixed list. */
class FakeDriver implements DeviceDriver {
  log: string[] = [];
  constructor(
    readonly kind: SimulatorKind,
    public devices: SimulatorDevice[],
    private space: InputSpace | undefined,
    private size = { width: 1179, height: 2556 },
  ) {}
  async list() {
    return this.devices;
  }
  async boot(id: string) {
    this.log.push(`boot ${id}`);
    const device = this.devices.find((item) => item.id === id)!;
    Object.assign(device, { state: "booted" });
    return device;
  }
  async shutdown(id: string) {
    this.log.push(`shutdown ${id}`);
  }
  async screenshot() {
    return png(this.size.width, this.size.height);
  }
  async inputSpace(_id: string, shot?: Buffer) {
    return this.kind === "android" ? { ...this.size } : this.space;
  }
  async inputAvailable() {
    return this.space !== undefined;
  }
  async tap(id: string, x: number, y: number, duration?: number) {
    this.log.push(`tap ${x} ${y}${duration ? ` ${duration}` : ""}`);
  }
  async swipe(
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration: number,
  ) {
    this.log.push(`swipe ${from.x} ${from.y} ${to.x} ${to.y} ${duration}`);
  }
  async touchPath(id: string, points: TouchPoint[]) {
    this.log.push(
      `path ${points.map((p) => `${p.x},${p.y},${p.dtMs}`).join(" ")}`,
    );
  }
  async text(id: string, value: string) {
    this.log.push(`text ${value}`);
    return { typed: value.length, dropped: 0 };
  }
  async button(id: string, name: string) {
    this.log.push(`button ${name}`);
  }
  async key(id: string, name: string) {
    this.log.push(`key ${name}`);
  }
  async openUrl(id: string, url: string) {
    this.log.push(`open ${url}`);
  }
  async launch(id: string, appPath: string, appId?: string) {
    this.log.push(`launch ${appPath} ${appId ?? ""}`);
    return { appId: appId ?? "com.example.App" };
  }
}

function setup(
  options: {
    answer?: DialogAnswer;
    ios?: boolean;
    devices?: SimulatorDevice[];
    space?: InputSpace | undefined;
    status?: IosSetupStatus;
    platform?: string;
  } = {},
) {
  const asked: ReturnType<typeof consentText>[] = [];
  let saved: string[] = [];
  let clock = 1_000;
  const consent = new Consent({
    ask: async (text) => {
      asked.push(text);
      return options.answer ?? "allow";
    },
    load: () => saved,
    save: (keys) => (saved = keys),
    now: () => clock,
  });
  const driver = new FakeDriver(
    "ios",
    options.devices ?? [{ ...phone }, { ...sleeping }],
    "space" in options ? options.space : { width: 393, height: 852 },
  );
  const service = new SimulatorService({
    platform: options.platform ?? "darwin",
    drivers: { ios: driver },
    scaler: fakeScaler,
    consent,
    switches: () => ({ ios: options.ios ?? true, android: true }),
    setup: async () =>
      options.status ?? { xcode: true, simulators: true, input: true },
  });
  return {
    service,
    driver,
    asked,
    saved: () => saved,
    advance: (ms: number) => (clock += ms),
  };
}

const control = (
  service: SimulatorService,
  args: Parameters<SimulatorService["control"]>[2],
  conversation = "c1",
) => service.control("ios", conversation, args);
const textOf = (result: Awaited<ReturnType<typeof control>>) =>
  result.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ");

test("the first use of a device asks, names it, and remembers Allow", async () => {
  const { service, asked, saved } = setup();
  const result = await control(service, { action: "attach" });
  assert.equal(result.success, true);
  assert.match(
    textOf(result),
    /Attached to iPhone 17 \(iOS 27\.0\)\. Coordinate space for tap\/swipe: 393x852 points/,
  );
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Allow Claudex to use iPhone 17?");
  assert.deepEqual(asked[0].buttons, ["Cancel", "Allow"]);
  assert.match(
    asked[0].detail,
    /control this simulator and take screenshots of its entire screen/,
  );
  assert.match(asked[0].detail, /Do not sign in to real accounts/);
  assert.deepEqual(saved(), [consentKey("ios", udid)]);
  await control(service, { action: "screenshot" });
  assert.equal(asked.length, 1);
});

test("Cancel stops Claudex, and it is not asked again for ten minutes", async () => {
  const { service, asked, advance, driver } = setup({ answer: "cancel" });
  const first = await control(service, { action: "screenshot" });
  assert.equal(first.success, false);
  assert.match(textOf(first), /declined to let Claudex use iPhone 17/);
  const second = await control(service, { action: "tap", x: 1, y: 1 });
  assert.equal(second.success, false);
  assert.equal(asked.length, 1);
  assert.deepEqual(driver.log, []);
  advance(declinedCooldownMs + 1);
  await control(service, { action: "screenshot" });
  assert.equal(asked.length, 2);
});

test("an unanswered dialog is reported as such", async () => {
  const { service } = setup({ answer: "timeout" });
  const result = await control(service, { action: "attach" });
  assert.equal(result.success, false);
  assert.match(textOf(result), /didn't answer/);
});

test("the person can allow a device in the pane, and take it back", async () => {
  const { service, asked } = setup({ answer: "cancel" });
  assert.equal(await service.hasAccess("ios", udid), false);
  await service.allow("ios", udid, true);
  assert.equal(await service.hasAccess("ios", udid), true);
  const result = await control(service, { action: "screenshot" });
  assert.equal(result.success, true);
  assert.equal(asked.length, 0);
  await service.allow("ios", udid, false);
  assert.equal(await service.hasAccess("ios", udid), false);
});

test("a screenshot carries the picture, scaled to the device's points", async () => {
  const { service } = setup();
  const result = await control(service, { action: "screenshot" });
  const image = result.parts.find((part) => part.type === "image");
  assert.ok(image && image.type === "image");
  assert.deepEqual([image.image.width, image.image.height], [393, 852]);
  assert.match(textOf(result), /393x852 points/);
});

test("taps map from the screenshot's space to the device", async () => {
  const { service, driver } = setup();
  await control(service, { action: "screenshot" });
  assert.equal(
    (await control(service, { action: "tap", x: 100, y: 200 })).success,
    true,
  );
  await control(service, { action: "tap", x: 10, y: 20, duration: 1 });
  await control(service, { action: "swipe", x: 1, y: 2, x2: 3, y2: 4 });
  await control(service, { action: "text", text: "hi" });
  await control(service, { action: "button", name: "HOME" });
  await control(service, { action: "open_url", url: "https://example.com" });
  assert.deepEqual(driver.log, [
    "tap 100 200",
    "tap 10 20 1",
    "swipe 1 2 3 4 0.3",
    "text hi",
    "button HOME",
    "open https://example.com",
  ]);
  const outside = await control(service, { action: "tap", x: 5000, y: 1 });
  assert.equal(outside.success, false);
  assert.match(textOf(outside), /outside the 393x852 screen/);
  assert.equal((await control(service, { action: "tap" })).success, false);
  assert.equal(
    (await control(service, { action: "open_url", url: "nope" })).success,
    false,
  );
});

test("a touch path keeps its waits, clamped", async () => {
  const { service, driver } = setup();
  const result = await control(service, {
    action: "touch_path",
    points: [
      { x: 1, y: 1 },
      { x: 2, y: 2, dt_ms: 5000 },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(driver.log, ["path 1,1,0 2,2,1000"]);
  assert.equal(
    (await control(service, { action: "touch_path", points: [{ x: 1, y: 1 }] }))
      .success,
    false,
  );
});

test("without idb the screenshot says taps are unavailable", async () => {
  const { service } = setup({ space: undefined });
  const result = await control(service, { action: "screenshot" });
  assert.match(textOf(result), /Facebook idb/);
  const tap = await control(service, { action: "tap", x: 1, y: 1 });
  assert.equal(tap.success, false);
});

test("a shut-down device boots for attach and launch only", async () => {
  const { service, driver } = setup({ devices: [{ ...sleeping }] });
  const blocked = await control(service, {
    action: "screenshot",
    device: "iPhone 18 Pro",
  });
  assert.equal(blocked.success, false);
  assert.match(textOf(blocked), /shut down\. Attach it first/);
  const attached = await control(service, {
    action: "attach",
    device: "iPhone 18 Pro",
  });
  assert.equal(attached.success, true);
  assert.deepEqual(driver.log, [`boot ${sleeping.id}`]);
  const launched = await control(service, {
    action: "launch",
    app_path: "/work/App.app",
  });
  assert.match(textOf(launched), /Launched com\.example\.App on iPhone 18 Pro/);
  assert.equal((await control(service, { action: "launch" })).success, false);
});

test("with nothing booted Claude is told how to boot a device", async () => {
  const { service } = setup({ devices: [{ ...sleeping }] });
  const result = await control(service, { action: "attach" });
  assert.equal(result.success, false);
  assert.match(
    textOf(result),
    /No booted simulator found\. Boot one with `xcrun simctl boot/,
  );
  const unknown = await control(service, { action: "attach", device: "Nokia" });
  assert.match(textOf(unknown), /No simulator named 'Nokia'/);
});

test("each conversation keeps the device it attached to; detach lets go", async () => {
  const second: SimulatorDevice = {
    ...phone,
    id: "44444444-4444-4444-4444-444444444444",
    name: "iPhone 16",
  };
  const { service, driver } = setup({ devices: [{ ...phone }, second] });
  await control(service, { action: "attach", device: "iPhone 16" }, "c2");
  assert.match(
    textOf(await control(service, { action: "screenshot" }, "c1")),
    /from iPhone 17/,
  );
  assert.match(
    textOf(await control(service, { action: "screenshot" }, "c2")),
    /from iPhone 16/,
  );
  const detached = await control(service, { action: "detach" }, "c2");
  assert.equal(detached.success, true);
  assert.deepEqual(driver.log, []);
  // After detach the conversation takes the first booted device again.
  assert.match(
    textOf(await control(service, { action: "screenshot" }, "c2")),
    /from iPhone 17/,
  );
});

test("Settings off, a platform without the kind, and an incomplete setup refuse with the reason", async () => {
  const off = await control(setup({ ios: false }).service, {
    action: "attach",
  });
  assert.equal(off.success, false);
  assert.match(
    textOf(off),
    /turned off in Settings \(Settings → Claudex Code → Mobile simulators → iOS Simulator\)/,
  );

  const windows = await control(setup({ platform: "win32" }).service, {
    action: "attach",
  });
  assert.match(textOf(windows), /requires macOS/);

  const noXcode = await control(
    setup({ status: { xcode: false, simulators: false, input: false } })
      .service,
    { action: "attach" },
  );
  assert.match(textOf(noXcode), /Xcode not found\. Install Xcode/);
  assert.match(
    setupProblem("ios", {
      xcodeSelectFixPath: "/Applications/Xcode.app/Contents/Developer",
      input: false,
    }),
    /sudo xcode-select -s \/Applications\/Xcode\.app\/Contents\/Developer/,
  );
  assert.match(
    setupProblem("ios", { xcode: true, simulators: false, input: false }),
    /Settings → Components/,
  );
  assert.match(
    setupProblem("android", { studioInstalled: true, platformTools: false }),
    /Couldn't find `adb`/,
  );
});

test("the pane's input is in fractions of the screen", async () => {
  const { service, driver } = setup();
  await service.input("ios", udid, { type: "tap", x: 0.5, y: 0.25 });
  await service.input("ios", udid, { type: "swipe", x: 0, y: 1, x2: 1, y2: 0 });
  await service.input("ios", udid, { type: "button", name: "HOME" });
  await service.input("ios", udid, { type: "key", name: "BACKSPACE" });
  assert.deepEqual(driver.log, [
    "tap 196.5 213",
    "swipe 0 852 393 0 0.3",
    "button HOME",
    "key BACKSPACE",
  ]);
  await assert.rejects(
    service.input("ios", udid, { type: "tap", x: 2, y: 0 }),
    SimulatorError,
  );
  await assert.rejects(
    service.input("ios", "bad id", { type: "text", value: "x" }),
    /Invalid device ID/,
  );
});

test("the pane's screen is a scaled picture with its size", async () => {
  const { service } = setup();
  const screen = await service.screen("ios", udid);
  assert.ok(screen);
  assert.match(screen.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual([screen.width, screen.height], [461, 1000]);
});

test("state follows the platform and the Settings switches", () => {
  const { service } = setup({ ios: false });
  assert.deepEqual(service.state().ios, { supported: true, enabled: false });
  assert.deepEqual(service.state().android, { supported: true, enabled: true });
  assert.deepEqual(setup({ platform: "linux" }).service.state().ios, {
    supported: false,
    enabled: true,
  });
});

test("small helpers", () => {
  assert.deepEqual(fitWithin({ width: 1080, height: 2400 }, 1280), {
    width: 576,
    height: 1280,
  });
  assert.deepEqual(fitWithin({ width: 300, height: 400 }, 1280), {
    width: 300,
    height: 400,
  });
  assert.equal(deviceLabel("  a \n b "), "a b");
  assert.equal(deviceLabel(""), "(unnamed device)");
  assert.equal(deviceLabel("x".repeat(100)).length, 64);
  assert.equal(
    consentText("android", "Pixel").detail.startsWith(
      "Claudex will control this emulator",
    ),
    true,
  );
});

test("only one dialog is open at a time", async () => {
  let release: (answer: DialogAnswer) => void = () => {};
  let asks = 0;
  const consent = new Consent({
    ask: () => {
      asks++;
      return new Promise<DialogAnswer>((resolve) => (release = resolve));
    },
    load: () => [],
    save: () => {},
    now: () => 0,
  });
  const a = consent.request({ kind: "ios", key: "ios:a", label: "A" });
  const same = consent.request({ kind: "ios", key: "ios:a", label: "A" });
  assert.equal(
    await consent.request({ kind: "ios", key: "ios:b", label: "B" }),
    "cooldown",
  );
  release("allow");
  assert.equal(await a, "granted");
  assert.equal(await same, "granted");
  assert.equal(asks, 1);
  assert.equal(
    await consent.request({ kind: "ios", key: "ios:a", label: "A" }),
    "granted",
  );
});

test("changed device tools require native re-approval, coalesce requests and persist only Allow", async () => {
  let saved = ["ios:a", "tools-signature:old"];
  let now = 0;
  let answer: (value: DialogAnswer) => void = () => {};
  const asked: ReturnType<typeof consentText>[] = [];
  const consent = new Consent({
    signature: "new",
    load: () => saved,
    save: (keys) => {
      saved = keys;
    },
    now: () => now,
    ask: (text) => {
      asked.push(text);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  assert.equal(consent.has("ios:a"), false);
  const first = consent.request({
    kind: "ios",
    key: "ios:a",
    label: "A",
    auto: true,
  });
  const second = consent.ensureTools();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Re-approve Claudex's device tools?");
  answer("cancel");
  assert.equal(await first, "declined");
  assert.equal(await second, "declined");
  assert.deepEqual(saved, ["ios:a", "tools-signature:old"]);
  assert.equal(await consent.ensureTools(), "cooldown");
  now += declinedCooldownMs;
  const retry = consent.ensureTools();
  answer("allow");
  assert.equal(await retry, "granted");
  assert.deepEqual(saved, ["ios:a", "tools-signature:new"]);
  assert.equal(consent.has("ios:a"), true);
  assert.equal(
    await consent.request({
      kind: "ios",
      key: "ios:b",
      label: "B",
      auto: true,
    }),
    "granted",
  );
  assert.equal(consent.has("ios:b"), false);
  assert.equal(asked.length, 2);
});

test("Auto simulator mode skips only device consent and explains that once per device", async () => {
  const { service, asked } = setup();
  service.permissionMode("auto-session", true);
  const first = await service.control("ios", "auto-session", {
    action: "attach",
    device: udid,
  });
  assert.equal(first.success, true);
  assert.match(
    first.parts[0].type === "text" ? first.parts[0].text : "",
    /This session is in Auto mode/,
  );
  assert.equal(asked.length, 0);
  const second = await service.control("ios", "auto-session", {
    action: "attach",
    device: udid,
  });
  assert.doesNotMatch(
    second.parts[0].type === "text" ? second.parts[0].text : "",
    /Auto mode/,
  );
  assert.equal(await service.hasAccess("ios", udid), false);
  service.permissionMode("auto-session", false);
  await service.control("ios", "auto-session", {
    action: "attach",
    device: udid,
  });
  assert.equal(asked.length, 1);
});

test("the pane's screen says the device's own size and its pixels per point when known", async () => {
  const { service, driver } = setup();
  const plain = await service.screen("ios", udid);
  assert.ok(plain);
  assert.deepEqual([plain.deviceWidth, plain.deviceHeight], [1179, 2556]);
  assert.equal(plain.pixelsPerPoint, undefined);
  let asked = 0;
  Object.assign(driver, {
    pixelsPerPoint: async () => {
      asked++;
      return 3;
    },
  });
  // A device that didn't answer is asked again only after a while.
  assert.equal((await service.screen("ios", udid))?.pixelsPerPoint, undefined);
  assert.equal(asked, 0);
  const other = setup();
  Object.assign(other.driver, {
    pixelsPerPoint: async () => {
      asked++;
      return 3;
    },
  });
  assert.equal((await other.service.screen("ios", udid))?.pixelsPerPoint, 3);
  assert.equal((await other.service.screen("ios", udid))?.pixelsPerPoint, 3);
  assert.equal(asked, 1);
});

test("airplane_mode switches the device's own airplane mode and turns it back off on detach", async () => {
  const { service, driver } = setup();
  assert.match(
    textOf(await control(service, { action: "airplane_mode", state: "on" })),
    /Android emulator only/,
  );
  let on = false;
  Object.assign(driver, {
    airplaneMode: async (_id: string, set?: boolean) => {
      if (set !== undefined) {
        driver.log.push(`airplane ${set ? "on" : "off"}`);
        on = set;
      }
      return on;
    },
  });
  assert.match(
    textOf(await control(service, { action: "airplane_mode" })),
    /requires state/,
  );
  assert.match(
    textOf(await control(service, { action: "airplane_mode", state: "on" })),
    /Turned airplane mode on for .*10\.0\.2\.2/,
  );
  assert.match(
    textOf(await control(service, { action: "airplane_mode", state: "on" })),
    /already on/,
  );
  await control(service, { action: "detach" });
  assert.deepEqual(driver.log, ["airplane on", "airplane off"]);
});

test("Rename… checks the name, and Restart boots the device again", async () => {
  const { service, driver } = setup();
  Object.assign(driver, {
    rename: async (id: string, name: string) =>
      void driver.log.push(`rename ${name}`),
    shutdown: async (id: string) => {
      driver.log.push(`shutdown ${id}`);
      Object.assign(
        driver.devices.find((d) => d.id === id)!,
        { state: "shutdown" },
      );
    },
  });
  await service.rename("ios", udid, "  Test Phone ");
  await assert.rejects(() => service.rename("ios", udid, "-x"), /hyphen/);
  assert.equal(await service.restart("ios", udid), udid);
  assert.deepEqual(driver.log, [
    "rename Test Phone",
    `shutdown ${udid}`,
    `boot ${udid}`,
  ]);
});
