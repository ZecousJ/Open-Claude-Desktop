import test from "node:test";
import assert from "node:assert/strict";
import {
  androidSteps,
  defaultDevice,
  deviceDetail,
  deviceText,
  gestureOf,
  iosSteps,
  keyPress,
  nameParts,
  nextZoom,
  paneReady,
  physicalZoom,
  stepZoom,
  zoomMax,
  zoomMin,
  zoomOf,
  zoomShortcut,
  pickerGroups,
  simulatorToggleShown,
  tapSlop,
} from "../../src/simulators/simulator-model";
import { dockPanels, openInDock } from "../../src/app/useToolPanels";
import type { SimulatorDevice } from "../../shared/simulators";
import { preference } from "../../shared/settings-extras";

const device = (
  name: string,
  state: SimulatorDevice["state"],
  osVersion?: string,
): SimulatorDevice => ({ kind: "ios", id: name, name, state, osVersion });

const states = (steps: { tiles: { key: string; state: string }[] }) =>
  steps.tiles.map((tile) => `${tile.key}:${tile.state}`);

test("iOS steps: no Xcode yet", () => {
  const steps = iosSteps({ xcode: false, simulators: false, input: false });
  assert.deepEqual(states(steps), ["xcode:current", "simulators:upcoming"]);
  assert.equal(steps.tiles[0].label, "Install Xcode");
  assert.equal(steps.tiles[0].sub, "Free from the Mac App Store.");
  assert.equal(steps.tiles[1].sub, "Available once Xcode is installed.");
  assert.equal(steps.polling, "Checking for Xcode…");
  assert.deepEqual(steps.action, {
    label: "Open Mac App Store",
    target: "app-store",
  });
});

test("iOS steps: Xcode is installed but not selected", () => {
  const steps = iosSteps({
    xcodeSelectFixPath: "/Applications/Xcode.app/Contents/Developer",
    input: false,
  });
  assert.deepEqual(states(steps), [
    "xcode:done",
    "select:current",
    "simulators:upcoming",
  ]);
  assert.equal(
    steps.tiles[1].command,
    "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
  );
  assert.equal(steps.tiles[2].sub, "Available once Xcode is selected.");
  assert.equal(steps.polling, "Checking the selected Xcode…");
  assert.equal(steps.action?.label, "Open Xcode");
  // Installed somewhere unusual: nothing to paste, and no button.
  const unusual = iosSteps({ xcodeSelectFixPath: "", input: false });
  assert.equal(unusual.tiles[1].command, undefined);
  assert.match(unusual.tiles[1].sub ?? "", /Settings → Locations/);
  assert.equal(unusual.action, undefined);
});

test("iOS steps: Xcode without the simulator runtime, then ready", () => {
  const waiting = iosSteps({
    xcode: true,
    xcodeVersion: "27.0",
    simulators: false,
    input: true,
  });
  assert.deepEqual(states(waiting), ["xcode:done", "simulators:current"]);
  assert.equal(waiting.tiles[0].sub, "Version 27.0");
  assert.match(waiting.tiles[1].sub ?? "", /Download & Install/);
  assert.equal(waiting.polling, "Checking for the simulator runtime…");
  assert.equal(
    paneReady("ios", { xcode: true, simulators: true, input: false }),
    true,
  );
  assert.equal(
    paneReady("ios", { xcode: true, simulators: false, input: true }),
    false,
  );
});

test("Android steps follow the original's order", () => {
  const none = androidSteps({ studioInstalled: false });
  assert.deepEqual(states(none), [
    "studio:current",
    "image:upcoming",
    "device:upcoming",
  ]);
  assert.equal(none.action?.target, "download-android-studio");
  assert.equal(none.polling, "Checking for the Android SDK…");

  const wizard = androidSteps({
    studioInstalled: true,
    platformTools: false,
    emulator: false,
  });
  assert.deepEqual(states(wizard), [
    "studio:done",
    "wizard:current",
    "image:upcoming",
    "device:upcoming",
  ]);
  assert.equal(wizard.tiles[0].label, "Android Studio installed");
  assert.equal(wizard.action?.target, "android-studio");

  const sdk = androidSteps({
    studioInstalled: true,
    platformTools: true,
    emulator: true,
    systemImage: false,
    avd: false,
  });
  assert.deepEqual(states(sdk), [
    "studio:done",
    "image:current",
    "device:upcoming",
  ]);
  assert.equal(sdk.tiles[0].label, "Android SDK installed");
  assert.equal(sdk.polling, "Checking for a system image…");

  const image = androidSteps({
    studioInstalled: true,
    platformTools: true,
    emulator: true,
    systemImage: true,
    avd: false,
  });
  assert.deepEqual(states(image), [
    "studio:done",
    "image:done",
    "device:current",
  ]);
  assert.equal(image.polling, "Checking for a virtual device…");
  assert.equal(
    paneReady("android", {
      studioInstalled: true,
      platformTools: true,
      emulator: true,
      systemImage: true,
      avd: true,
    }),
    true,
  );
});

test("the picker groups booted devices and the ones that would boot", () => {
  const list = [
    device("A", "shutdown", "iOS 27.0"),
    device("B", "booted", "iOS 27.0"),
    device("C", "booting"),
  ];
  const groups = pickerGroups(list);
  assert.deepEqual(
    groups.booted.map((item) => item.name),
    ["B"],
  );
  assert.deepEqual(
    groups.available.map((item) => item.name),
    ["A"],
  );
  assert.equal(defaultDevice(list)?.name, "B");
  assert.equal(defaultDevice([device("A", "shutdown")])?.name, "A");
  assert.equal(defaultDevice([]), undefined);
  assert.equal(deviceText(list[0]), "A (iOS 27.0)");
  assert.equal(deviceText(device("Pixel", "booted")), "Pixel");
});

const box = { left: 100, top: 50, width: 200, height: 400 };

test("a short press is a tap in fractions of the picture, a long one a long press", () => {
  assert.deepEqual(
    gestureOf({ x: 200, y: 250, at: 0 }, { x: 201, y: 251, at: 100 }, box),
    { type: "tap", x: 0.5, y: 0.5 },
  );
  assert.deepEqual(
    gestureOf({ x: 100, y: 50, at: 0 }, { x: 100, y: 50, at: 1500 }, box),
    { type: "tap", x: 0, y: 0, duration: 1.5 },
  );
});

test("a drag is a swipe over the time it took, kept inside the picture", () => {
  const swipe = gestureOf(
    { x: 200, y: 450, at: 0 },
    { x: 200, y: 50 - 30, at: 300 },
    box,
  );
  assert.deepEqual(swipe, {
    type: "swipe",
    x: 0.5,
    y: 1,
    x2: 0.5,
    y2: 0,
    duration: 0.3,
  });
  assert.equal(
    gestureOf({ x: 0, y: 0, at: 0 }, { x: tapSlop - 1, y: 0, at: 10 }, box)
      ?.type,
    "tap",
  );
  assert.equal(
    gestureOf({ x: 0, y: 0, at: 0 }, { x: tapSlop, y: 0, at: 10 }, box)?.type,
    "swipe",
  );
  assert.equal(
    gestureOf(
      { x: 0, y: 0, at: 0 },
      { x: 1, y: 1, at: 1 },
      { ...box, width: 0 },
    ),
    undefined,
  );
});

test("keys: characters are text, Enter and Backspace are keys, shortcuts are not sent", () => {
  const key = (name: string, extra: object = {}) =>
    keyPress({
      key: name,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...extra,
    });
  assert.deepEqual(key("a"), { text: "a" });
  assert.deepEqual(key(" "), { text: " " });
  assert.deepEqual(key("é"), { text: "é" });
  assert.deepEqual(key("Enter"), { key: "ENTER" });
  assert.deepEqual(key("Backspace"), { key: "BACKSPACE" });
  assert.equal(key("ArrowLeft"), undefined);
  assert.equal(key("Shift"), undefined);
  assert.equal(key("c", { metaKey: true }), undefined);
});

test("the title bar's toggles: Code on the desktop, where the computer can run the kind and Settings has it on", () => {
  const base = {
    mode: "code",
    desktop: true,
    platform: "darwin",
    settings: {},
  };
  assert.equal(simulatorToggleShown({ ...base, kind: "ios" }), true);
  assert.equal(simulatorToggleShown({ ...base, kind: "android" }), true);
  assert.equal(
    simulatorToggleShown({ ...base, kind: "ios", platform: "win32" }),
    false,
  );
  assert.equal(
    simulatorToggleShown({ ...base, kind: "android", platform: "win32" }),
    true,
  );
  assert.equal(
    simulatorToggleShown({ ...base, kind: "ios", mode: "chat" }),
    false,
  );
  assert.equal(
    simulatorToggleShown({ ...base, kind: "ios", desktop: false }),
    false,
  );
  assert.equal(
    simulatorToggleShown({
      ...base,
      kind: "ios",
      settings: { iosSimulatorAccess: false },
    }),
    false,
  );
  assert.equal(
    simulatorToggleShown({
      ...base,
      kind: "android",
      settings: { iosSimulatorAccess: false },
    }),
    true,
  );
  assert.equal(
    simulatorToggleShown({ ...base, kind: "ios", platform: undefined }),
    false,
  );
});

test("both switches are on until turned off", () => {
  assert.equal(preference({}, "iosSimulatorAccess"), true);
  assert.equal(
    preference({ androidEmulatorAccess: false }, "androidEmulatorAccess"),
    false,
  );
});

test("the simulators open in the dock's column, after the browser and before the terminal", () => {
  assert.deepEqual(dockPanels.slice(-4), [
    "browser",
    "ios-simulator",
    "android-emulator",
    "terminal",
  ]);
  assert.deepEqual(openInDock(["terminal", "changes"], "android-emulator"), [
    "changes",
    "android-emulator",
    "terminal",
  ]);
});

test("the picker's lines: the name, then the OS version (and a running emulator's serial)", () => {
  assert.equal(
    deviceDetail(device("iPhone 17", "booted", "iOS 27.0")),
    "iOS 27.0",
  );
  assert.equal(deviceDetail(device("iPhone 17", "booted")), undefined);
  assert.equal(
    deviceDetail({
      kind: "android",
      id: "emulator-5554",
      name: "Pixel 9",
      state: "booted",
      avd: "Pixel_9",
    }),
    "emulator-5554",
  );
  assert.equal(
    deviceDetail({
      kind: "android",
      id: "Pixel_9",
      name: "Pixel 9",
      state: "shutdown",
      avd: "Pixel_9",
    }),
    undefined,
  );
  assert.deepEqual(nameParts("iPhone 17"), { head: "iPhone 17" });
  assert.deepEqual(nameParts("iPhone 17 Pro Max"), {
    head: "iPhone 17",
    tail: " Pro Max",
  });
  assert.deepEqual(nameParts("iPad Pro 13-inch (M5)"), {
    head: "iPad Pro 13-in",
    tail: "ch (M5)",
  });
});

test("zoom steps by a quarter between an eighth and one device pixel per CSS pixel", () => {
  assert.equal(stepZoom(0.5, "in"), 0.625);
  assert.equal(stepZoom(0.5, "out"), 0.4);
  assert.equal(stepZoom(0.9, "in"), zoomMax);
  assert.equal(stepZoom(zoomMax, "in"), undefined);
  assert.equal(stepZoom(0.13, "out"), zoomMin);
  assert.equal(stepZoom(zoomMin, "out"), undefined);
});

test("zoom actions: fit, physical size and the steps from where the picture is", () => {
  const physical = physicalZoom({ pixelsPerPoint: 3 });
  assert.equal(physical, 1 / 3);
  assert.equal(physicalZoom({}), null);
  // Fitted at a quarter of the device's pixels.
  assert.equal(nextZoom("fit", "fit", 0.25, physical), undefined);
  assert.equal(nextZoom("in", "fit", 0.25, physical), 0.3125);
  assert.equal(nextZoom("physical", "fit", 0.25, physical), "physical");
  assert.equal(nextZoom("physical", "fit", 0.25, null), undefined);
  assert.equal(nextZoom("physical", "physical", physical, physical), undefined);
  assert.equal(nextZoom("fit", "physical", physical, physical), "fit");
  // Before the picture is drawn the steps wait.
  assert.equal(nextZoom("in", "fit", null, physical), undefined);
  // A step that lands on Physical size is Physical size.
  assert.equal(nextZoom("in", 0.32 / 1.25, 0.32 / 1.25, 0.32), "physical");
  assert.equal(zoomOf("fit", physical), null);
  assert.equal(zoomOf("physical", physical), physical);
  assert.equal(zoomOf(0.5, physical), 0.5);
});

test("zoom shortcuts: ⌘- ⌘0 ⌘1 ⌘+ on the Mac, Ctrl elsewhere", () => {
  const key = (k: string, mods: Partial<Record<string, boolean>> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  assert.equal(zoomShortcut(key("-", { metaKey: true }), true), "out");
  assert.equal(zoomShortcut(key("=", { metaKey: true }), true), "in");
  assert.equal(
    zoomShortcut(key("+", { metaKey: true, shiftKey: true }), true),
    "in",
  );
  assert.equal(zoomShortcut(key("0", { metaKey: true }), true), "fit");
  assert.equal(zoomShortcut(key("1", { metaKey: true }), true), "physical");
  assert.equal(zoomShortcut(key("1", { ctrlKey: true }), true), undefined);
  assert.equal(zoomShortcut(key("1", { ctrlKey: true }), false), "physical");
  assert.equal(zoomShortcut(key("1"), true), undefined);
  assert.equal(zoomShortcut(key("a", { metaKey: true }), true), undefined);
});
