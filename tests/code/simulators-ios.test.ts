import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IosDriver } from "../../electron/simulators/ios";
import {
  idbCommands,
  iosCommands,
  parseIdbSpace,
  parseSimctlDevices,
  pixelRatio,
  runtimeName,
  simulatorShortcutScript,
} from "../../electron/simulators/ios-commands";
import { SimulatorError } from "../../electron/simulators/driver";
import { CommandError } from "../../electron/simulators/runner";
import { FakeRunner, iosList, png } from "../support/simulators-fakes";

const udid = "33333333-3333-3333-3333-333333333333";

test("Simulator native rotation and edit shortcuts use Mac key codes", () => {
  assert.match(
    simulatorShortcutScript(124),
    /key code 124 using \{command down\}/,
  );
  assert.match(
    simulatorShortcutScript(6, true),
    /key code 6 using \{command down, shift down\}/,
  );
  assert.match(simulatorShortcutScript(9), /tell process "Simulator"/);
});

test("simctl devices: iOS runtimes only, booted first, newest runtime first", () => {
  const devices = parseSimctlDevices(iosList);
  assert.deepEqual(
    devices.map((device) => [device.name, device.state, device.osVersion]),
    [
      ["iPhone 17", "booted", "iOS 27.0"],
      ["iPhone 18 Pro", "shutdown", "iOS 27.0"],
      ["iPhone 16", "shutdown", "iOS 26.4"],
    ],
  );
  assert.ok(devices.every((device) => device.kind === "ios"));
});

test("simctl devices: states and unusable entries", () => {
  const list = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        { udid, name: "A", state: "Booting", isAvailable: true },
        {
          udid: "66666666-6666-6666-6666-666666666666",
          name: "B",
          state: "Shutting Down",
          isAvailable: true,
        },
        {
          udid: "77777777-7777-7777-7777-777777777777",
          name: "C",
          state: "Creating",
          isAvailable: true,
        },
        { udid: "not-a-udid", name: "D", state: "Booted" },
      ],
    },
  });
  assert.deepEqual(
    parseSimctlDevices(list).map((device) => device.state),
    ["booting", "shutting-down"],
  );
  assert.throws(() => parseSimctlDevices("nope"), SimulatorError);
  assert.deepEqual(parseSimctlDevices("{}"), []);
});

test("runtime names", () => {
  assert.equal(
    runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-27-0"),
    "iOS 27.0",
  );
  assert.equal(
    runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-17-5-1"),
    "iOS 17.5.1",
  );
  assert.equal(
    runtimeName("com.apple.CoreSimulator.SimRuntime.tvOS-18-0"),
    undefined,
  );
});

test("simctl and idb command lines are argument arrays", () => {
  assert.deepEqual(iosCommands.screenshot(udid, "/tmp/x/screen.png"), [
    "simctl",
    "io",
    udid,
    "screenshot",
    "--type=png",
    "/tmp/x/screen.png",
  ]);
  assert.deepEqual(iosCommands.launch(udid, "com.example.App"), [
    "simctl",
    "launch",
    udid,
    "com.example.App",
  ]);
  assert.deepEqual(idbCommands.tap(udid, 10.6, 20.2), [
    "ui",
    "tap",
    "--udid",
    udid,
    "11",
    "20",
  ]);
  assert.deepEqual(idbCommands.tap(udid, 1, 2, 1.5).slice(3, 6), [
    udid,
    "--duration",
    "1.5",
  ]);
  // Text that begins with a dash is not an option.
  assert.deepEqual(idbCommands.text(udid, "-rf; $(x)").slice(-2), [
    "--",
    "-rf; $(x)",
  ]);
  assert.deepEqual(idbCommands.button(udid, "HOME").slice(-2), [udid, "HOME"]);
  assert.equal(
    idbCommands.swipe(udid, { x: 1, y: 2 }, { x: 3, y: 4 }, 0).at(5),
    "0.05",
  );
});

test("idb describe: the size in points", () => {
  assert.deepEqual(
    parseIdbSpace(
      JSON.stringify({
        screen_dimensions: {
          width: 1179,
          height: 2556,
          width_points: 393,
          height_points: 852,
        },
      }),
    ),
    { width: 393, height: 852 },
  );
  assert.equal(parseIdbSpace("{}"), undefined);
  assert.equal(parseIdbSpace("not json"), undefined);
});

function driver(options: { idb?: boolean; runner?: FakeRunner } = {}) {
  const runner =
    options.runner ??
    new FakeRunner((file, args) => {
      if (args[1] === "list") return iosList;
      if (args[0] === "describe")
        return JSON.stringify({
          screen_dimensions: { width_points: 393, height_points: 852 },
        });
      return "";
    });
  return {
    runner,
    driver: new IosDriver({
      runner,
      findIdb: async () =>
        options.idb === false ? undefined : "/opt/homebrew/bin/idb",
      isDirectory: async (folder) => folder.endsWith(".app"),
    }),
  };
}

test("rotation, editing, keyboard and slow animations reach the simulator", async () => {
  let slow = "0";
  const notification = "com.apple.UIKit.SimulatorSlowMotionAnimationState";
  const runner = new FakeRunner((_file, args) => {
    if (args.includes("notifyutil")) {
      if (args.includes("-s")) slow = args[args.indexOf("-s") + 2];
      return `${notification} ${slow}`;
    }
    if (args.includes("defaults")) return "1";
    return "";
  });
  const { driver: ios } = driver({ runner });
  await ios.rotate(udid);
  for (const action of [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ] as const)
    await ios.edit(udid, action);
  assert.equal(runner.calls.filter((call) => call.file === "open").length, 7);
  assert.ok(
    runner.calls
      .filter((call) => call.file === "open")
      .every((call) => call.args.at(-1) === udid),
  );
  assert.match(
    runner.lines("/usr/bin/osascript").join("\n"),
    /key code 6 using \{command down, shift down\}/,
  );
  assert.equal(await ios.softwareKeyboard(udid), false);
  assert.equal(await ios.softwareKeyboard(udid, true), true);
  assert.equal(await ios.slowAnimations(udid), false);
  assert.equal(await ios.slowAnimations(udid, true), true);
  assert.equal(await ios.slowAnimations(udid, false), false);
});

test("boot waits for the device and tolerates one that is already booted", async () => {
  const { runner, driver: ios } = driver({
    runner: new FakeRunner((file, args) => {
      if (args[1] === "list") return iosList;
      if (args[1] === "boot")
        return new CommandError(
          "failed",
          file,
          149,
          "Unable to boot device in current state: Booted",
        );
      return "";
    }),
  });
  const device = await ios.boot(udid);
  assert.equal(device.name, "iPhone 17");
  assert.deepEqual(runner.lines("xcrun").slice(0, 2), [
    `xcrun simctl boot ${udid}`,
    `xcrun simctl bootstatus ${udid}`,
  ]);
});

test("boot passes other failures on", async () => {
  const { driver: ios } = driver({
    runner: new FakeRunner(
      (file) => new CommandError("failed", file, 1, "No such device"),
    ),
  });
  await assert.rejects(ios.boot(udid), CommandError);
});

test("input goes through idb, in points, and says so when idb is missing", async () => {
  const { runner, driver: ios } = driver();
  await ios.tap(udid, 100, 200);
  await ios.swipe(udid, { x: 1, y: 2 }, { x: 3, y: 4 }, 0.5);
  await ios.text(udid, "hello");
  await ios.button(udid, "HOME");
  await ios.key(udid, "ENTER");
  assert.deepEqual(runner.lines("/opt/homebrew/bin/idb"), [
    `/opt/homebrew/bin/idb ui tap --udid ${udid} 100 200`,
    `/opt/homebrew/bin/idb ui swipe --udid ${udid} --duration 0.5 1 2 3 4`,
    `/opt/homebrew/bin/idb ui text --udid ${udid} -- hello`,
    `/opt/homebrew/bin/idb ui button --udid ${udid} HOME`,
    `/opt/homebrew/bin/idb ui key --udid ${udid} 40`,
  ]);
  assert.deepEqual(await ios.inputSpace(udid), { width: 393, height: 852 });

  const { driver: bare } = driver({ idb: false });
  await assert.rejects(
    bare.tap(udid, 1, 1),
    (error) =>
      error instanceof SimulatorError && /Facebook idb/.test(error.message),
  );
  assert.equal(await bare.inputAvailable(), false);
  assert.equal(await bare.inputSpace(udid), undefined);
});

test("a touch path is one swipe from the first point to the last", async () => {
  const { runner, driver: ios } = driver();
  await ios.touchPath(udid, [
    { x: 10, y: 10, dtMs: 0 },
    { x: 20, y: 20, dtMs: 500 },
    { x: 50, y: 60, dtMs: 500 },
  ]);
  assert.match(
    runner.lines("/opt/homebrew/bin/idb")[0],
    /--duration 1 10 10 50 60$/,
  );
});

test("launch installs the .app and starts its bundle", async () => {
  const { runner, driver: ios } = driver({
    runner: new FakeRunner((file, args) =>
      file === "plutil" ? "com.example.MyApp\n" : "",
    ),
  });
  const launched = await ios.launch(udid, "/work/build/MyApp.app");
  assert.equal(launched.appId, "com.example.MyApp");
  assert.deepEqual(runner.lines(), [
    "plutil -extract CFBundleIdentifier raw -o - /work/build/MyApp.app/Info.plist",
    `xcrun simctl install ${udid} /work/build/MyApp.app`,
    `xcrun simctl launch ${udid} com.example.MyApp`,
  ]);
  await assert.rejects(
    ios.launch(udid, "/work/build/notes.txt"),
    SimulatorError,
  );
  await assert.rejects(
    ios.launch(udid, "/work/MyApp.app", "bad id; rm -rf"),
    SimulatorError,
  );
});

test("screenshots go through a private temporary file (Xcode 27 writes no PNG to standard output)", async () => {
  const picture = png(1179, 2556);
  const { driver: ios, runner } = driver({
    runner: new FakeRunner((file, args) => {
      fs.writeFileSync(String(args.at(-1)), picture);
      return "";
    }),
  });
  assert.deepEqual(await ios.screenshot(udid), picture);
  const target = String(runner.calls[0].args.at(-1));
  assert.ok(path.isAbsolute(target) && target.endsWith("screen.png"));
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test("pixels per point: the screenshot over idb's size in points, none without idb", async () => {
  assert.equal(
    pixelRatio({ width: 1179, height: 2556 }, { width: 393, height: 852 }),
    3,
  );
  // Rotated: the longer edges still match.
  assert.equal(
    pixelRatio({ width: 2556, height: 1179 }, { width: 393, height: 852 }),
    3,
  );
  assert.equal(
    pixelRatio({ width: 1179, height: 2556 }, { width: 10, height: 10 }),
    undefined,
  );
  assert.equal(await driver().driver.pixelsPerPoint(udid, png(1179, 2556)), 3);
  assert.equal(
    await driver({ idb: false }).driver.pixelsPerPoint(udid, png(1179, 2556)),
    undefined,
  );
});
