import test from "node:test";
import assert from "node:assert/strict";
import { AndroidDriver } from "../../electron/simulators/android";
import {
  adbCommands,
  androidKeyCodes,
  androidTextInput,
  deviceQuote,
  parseAdbDevices,
  parseAvdDisplayName,
  parseAvdList,
  parseAvdName,
  parseDensity,
} from "../../electron/simulators/android-commands";
import { SimulatorError } from "../../electron/simulators/driver";
import { FakeRunner, png } from "../support/simulators-fakes";

const devicesOutput = `List of devices attached
emulator-5554          device product:sdk_gphone64 model:sdk_gphone64 device:emu64 transport_id:1
emulator-5556          offline transport_id:2
R58M12345AB            device usb:1-1 product:beyond1 model:SM_G973F transport_id:3

`;

test("adb devices: emulators only, a phone on a cable is ignored", () => {
  assert.deepEqual(parseAdbDevices(devicesOutput), [
    { serial: "emulator-5554", state: "device" },
    { serial: "emulator-5556", state: "offline" },
  ]);
  assert.deepEqual(parseAdbDevices("List of devices attached\n"), []);
});

test("AVD names and display names", () => {
  assert.deepEqual(
    parseAvdList(
      "INFO    | Storing crashdata in: /tmp\nPixel_9_API_35\nTablet_API_34\n",
    ),
    ["Pixel_9_API_35", "Tablet_API_34"],
  );
  assert.equal(parseAvdName("Pixel_9_API_35\nOK\n"), "Pixel_9_API_35");
  assert.equal(parseAvdName("KO: unknown command\n"), undefined);
  assert.equal(
    parseAvdDisplayName(
      "hw.ramSize=2048\navd.ini.displayname = Pixel 9 API 35\n",
    ),
    "Pixel 9 API 35",
  );
  assert.equal(parseAvdDisplayName("hw.ramSize=2048"), undefined);
});

test("typed text keeps safe characters, turns spaces into %s and counts what it drops", () => {
  const result = androidTextInput("hi there; $(rm -rf /) é");
  assert.deepEqual(result.chunks, ["hi%sthere%srm%s-rf%s/%s"]);
  assert.equal(result.dropped, 5);
  assert.equal(result.typed, "hi there; $(rm -rf /) é".length - 5);
  // Long text is cut in pieces, never inside a %s.
  const long = androidTextInput("a ".repeat(300));
  assert.ok(long.chunks.length > 1);
  assert.ok(
    long.chunks.every((chunk) => chunk.length <= 200 && !chunk.endsWith("%")),
  );
  assert.equal(long.chunks.join(""), "a%s".repeat(300));
});

test("what runs on the device is quoted", () => {
  assert.equal(deviceQuote("it's"), `'it'\\''s'`);
  assert.deepEqual(
    adbCommands.openUrl("emulator-5554", "https://x.dev/?a=1&b=2;id"),
    [
      "-s",
      "emulator-5554",
      "shell",
      `am start -a android.intent.action.VIEW -d 'https://x.dev/?a=1&b=2;id'`,
    ],
  );
  assert.deepEqual(adbCommands.text("emulator-5554", "a%sb").slice(-1), [
    `input text 'a%sb'`,
  ]);
  assert.deepEqual(adbCommands.tap("emulator-5554", 10.4, 20.6).slice(-4), [
    "input",
    "tap",
    "10",
    "21",
  ]);
  assert.equal(androidKeyCodes.HOME, 3);
  assert.equal(androidKeyCodes.RECENTS, 187);
});

function fake(state: { serials?: string[]; booted?: boolean } = {}) {
  let up = [...(state.serials ?? ["emulator-5554"])];
  let completed = state.booted ?? true;
  const runner = new FakeRunner((file, args) => {
    if (file.endsWith("emulator"))
      return "INFO | x\nPixel_9_API_35\nTablet_API_34\n";
    const rest = args[0] === "-s" ? args.slice(2) : args;
    if (rest[0] === "devices")
      return `List of devices attached\n${up.map((serial) => `${serial}\tdevice`).join("\n")}\n`;
    if (rest[0] === "emu" && rest[1] === "avd")
      return `${args[1] === "emulator-5554" ? "Pixel_9_API_35" : "Tablet_API_34"}\nOK\n`;
    if (rest[0] === "emu" && rest[1] === "kill") {
      up = up.filter((serial) => serial !== args[1]);
      return "OK\n";
    }
    if (rest.includes("sys.boot_completed")) return completed ? "1\n" : "\n";
    if (rest[0] === "exec-out") return png(1080, 2400);
    if (rest[0] === "shell" && rest[1]?.startsWith?.("am "))
      return "Starting: Intent\n";
    if (rest[1] === "monkey") return "Events injected: 1\n";
    if (rest[0] === "shell" && rest[1] === "wm")
      return "Physical density: 420\nOverride density: 480\n";
    return "";
  });
  let clock = 0;
  const driver = new AndroidDriver({
    runner,
    adb: async () => "/sdk/platform-tools/adb",
    emulator: async () => "/sdk/emulator/emulator",
    avdConfig: async (name) =>
      name === "Pixel_9_API_35"
        ? "avd.ini.displayname = Pixel 9 API 35\n"
        : undefined,
    isFile: async (file) => file.endsWith(".apk"),
    sleep: async (ms) => {
      clock += ms;
      // The emulator appears two polls after it was started.
      if (
        runner.detached.length &&
        clock > 3000 &&
        !up.includes("emulator-5556")
      ) {
        up = [...up, "emulator-5556"];
        completed = true;
      }
    },
    now: () => clock,
  });
  return {
    runner,
    driver,
    up: () => up,
    setCompleted: (value: boolean) => (completed = value),
  };
}

test("the list has running emulators first, then the virtual devices that would boot", async () => {
  const { driver } = fake();
  const devices = await driver.list();
  assert.deepEqual(
    devices.map((device) => [device.id, device.name, device.state, device.avd]),
    [
      ["emulator-5554", "Pixel 9 API 35", "booted", "Pixel_9_API_35"],
      ["Tablet_API_34", "Tablet_API_34", "shutdown", "Tablet_API_34"],
    ],
  );
});

test("without adb the error says how to get it", async () => {
  const driver = new AndroidDriver({
    runner: new FakeRunner(() => ""),
    adb: async () => undefined,
    emulator: async () => undefined,
    avdConfig: async () => undefined,
    isFile: async () => false,
    sleep: async () => {},
    now: () => 0,
  });
  await assert.rejects(
    driver.list(),
    (error) =>
      error instanceof SimulatorError &&
      /Couldn't find `adb`/.test(error.message),
  );
});

test("boot starts the AVD without a window and waits for the system to finish booting", async () => {
  const { runner, driver } = fake();
  const device = await driver.boot("Tablet_API_34");
  assert.deepEqual(runner.detached, [
    {
      file: "/sdk/emulator/emulator",
      args: ["-avd", "Tablet_API_34", "-no-window"],
    },
  ]);
  assert.equal(device.id, "emulator-5556");
  assert.equal(device.state, "booted");
});

test("a running emulator boots as itself, and an unknown name is refused", async () => {
  const { runner, driver } = fake();
  assert.equal((await driver.boot("emulator-5554")).id, "emulator-5554");
  assert.equal((await driver.boot("Pixel_9_API_35")).id, "emulator-5554");
  assert.equal(runner.detached.length, 0);
  await assert.rejects(
    driver.boot("Nope_AVD"),
    (error) =>
      error instanceof SimulatorError &&
      /No AVD named 'Nope_AVD'/.test(error.message),
  );
  await assert.rejects(driver.boot("not an avd!"), SimulatorError);
});

test("shut down sends the console's kill to that emulator only", async () => {
  const { runner, driver, up } = fake({
    serials: ["emulator-5554", "emulator-5556"],
  });
  await driver.shutdown("emulator-5556");
  assert.ok(
    runner
      .lines()
      .includes("/sdk/platform-tools/adb -s emulator-5556 emu kill"),
  );
  assert.deepEqual(up(), ["emulator-5554"]);
  // An emulator that is not running is already shut down.
  await driver.shutdown("Tablet_API_34");
});

test("input goes to one serial; touch paths use motion events and always lift", async () => {
  const { runner, driver } = fake();
  await driver.tap("emulator-5554", 100, 200);
  await driver.tap("emulator-5554", 100, 200, 1);
  await driver.touchPath("emulator-5554", [
    { x: 1, y: 2, dtMs: 0 },
    { x: 3, y: 4, dtMs: 10 },
  ]);
  const adb = runner
    .lines("/sdk/platform-tools/adb")
    .filter((line) => line.includes(" shell "));
  assert.deepEqual(adb, [
    "/sdk/platform-tools/adb -s emulator-5554 shell input tap 100 200",
    "/sdk/platform-tools/adb -s emulator-5554 shell input swipe 100 200 100 200 1000",
    "/sdk/platform-tools/adb -s emulator-5554 shell input motionevent DOWN 1 2",
    "/sdk/platform-tools/adb -s emulator-5554 shell input motionevent MOVE 3 4",
    "/sdk/platform-tools/adb -s emulator-5554 shell input motionevent UP 3 4",
  ]);
  const result = await driver.text("emulator-5554", "a b;");
  assert.deepEqual(result, { typed: 3, dropped: 1 });
  await driver.button("emulator-5554", "BACK");
  assert.ok(runner.lines().at(-1)?.endsWith("input keyevent 4"));
  await assert.rejects(driver.button("emulator-5554", "SIRI"), SimulatorError);
  await driver.key("emulator-5554", "BACKSPACE");
  assert.ok(runner.lines().at(-1)?.endsWith("input keyevent 67"));
});

test("a device that is not a running emulator is refused", async () => {
  const { driver } = fake();
  await assert.rejects(driver.tap("emulator-9999", 1, 1), /not running/);
  await assert.rejects(driver.screenshot("R58M12345AB"), /not running/);
});

test("the input space is the screenshot's pixels", async () => {
  const { driver } = fake();
  assert.deepEqual(await driver.inputSpace("emulator-5554"), {
    width: 1080,
    height: 2400,
  });
});

test("launch installs the APK and starts the package", async () => {
  const { runner, driver } = fake();
  const launched = await driver.launch(
    "emulator-5554",
    "/work/app-debug.apk",
    "com.example.app",
  );
  assert.equal(launched.appId, "com.example.app");
  const lines = runner.lines("/sdk/platform-tools/adb");
  assert.ok(
    lines.some((line) => line.endsWith("install -r /work/app-debug.apk")),
  );
  assert.ok(
    lines.some((line) =>
      line.endsWith(
        "shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1",
      ),
    ),
  );
  await assert.rejects(
    driver.launch("emulator-5554", "/work/app-debug.apk"),
    /bundle_id/,
  );
  await assert.rejects(
    driver.launch("emulator-5554", "/work/app-debug.apk", "x; reboot"),
    SimulatorError,
  );
  await assert.rejects(
    driver.launch("emulator-5554", "/work/app.zip", "com.example.app"),
    /\.apk/,
  );
});

test("wm density: the override wins over the physical density", () => {
  assert.equal(parseDensity("Physical density: 420\n"), 420);
  assert.equal(
    parseDensity("Physical density: 420\nOverride density: 480\n"),
    480,
  );
  assert.equal(parseDensity("nothing here"), undefined);
  assert.equal(parseDensity("Physical density: 0"), undefined);
});

test("pixels per point are the density over 160 dpi, read once per emulator", async () => {
  const { driver, runner } = fake();
  assert.equal(await driver.pixelsPerPoint("emulator-5554"), 3);
  assert.equal(await driver.pixelsPerPoint("emulator-5554"), 3);
  assert.equal(
    runner.lines().filter((line) => line.endsWith("wm density")).length,
    1,
  );
});
