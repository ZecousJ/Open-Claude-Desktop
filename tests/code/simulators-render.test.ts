import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { iosSteps } from "../../src/simulators/simulator-model";
import {
  AttachScreen,
  Checking,
  PermissionScreen,
  SetupScreen,
  Unavailable,
  Working,
  deviceEntries,
} from "../../src/simulators/SimulatorScreens";
import { DeviceView } from "../../src/simulators/SimulatorDevice";
import { deviceMenuFooter } from "../../src/simulators/DeviceControls";
import { MobileSimulatorsSection } from "../../src/simulators/MobileSimulatorsSection";
import { defaultSettings } from "../../electron/store/store";
import type { SimulatorDevice } from "../../shared/simulators";

const device = (
  name: string,
  state: SimulatorDevice["state"],
  osVersion?: string,
): SimulatorDevice => ({ kind: "ios", id: name, name, state, osVersion });

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(node);

test("the setup screen shows the tiles, the polling line, the footnote and the button", () => {
  const markup = html(
    createElement(SetupScreen, {
      steps: iosSteps({
        xcodeSelectFixPath: "/Applications/Xcode.app/Contents/Developer",
        input: false,
      }),
      onOpen: () => {},
      onCopy: () => {},
    }),
  );
  assert.match(markup, /Set up the iOS simulator/);
  assert.match(
    markup,
    /Progress updates automatically as each step finishes\./,
  );
  assert.match(
    markup,
    /sudo xcode-select -s \/Applications\/Xcode\.app\/Contents\/Developer/,
  );
  assert.match(markup, /Checking the selected Xcode…/);
  assert.match(markup, /Xcode is a trademark of Apple Inc\./);
  assert.match(markup, />Open Xcode</);
});

test("the attach screen has the split button and words each kind its own way", () => {
  const devices = [device("iPhone 17", "booted", "iOS 27.0")];
  const ios = html(
    createElement(AttachScreen, { kind: "ios", devices, onAttach: () => {} }),
  );
  assert.match(ios, /Attach a simulator so Claudex can see your app/);
  assert.match(ios, /Shut-down devices boot automatically\./);
  assert.match(ios, />Attach simulator</);
  assert.match(ios, /aria-label="Choose simulator"/);
  const android = html(
    createElement(AttachScreen, {
      kind: "android",
      devices: [],
      busy: "boot",
      onAttach: () => {},
    }),
  );
  assert.match(android, /Attach an emulator so Claudex can see your app/);
  assert.match(android, />Booting…</);
  assert.doesNotMatch(android, /simulator/);
  const failed = html(
    createElement(AttachScreen, {
      kind: "ios",
      devices,
      failure: { title: "Couldn’t start the simulator", detail: "boom" },
      onAttach: () => {},
    }),
  );
  assert.match(failed, /Couldn’t start the simulator/);
  assert.match(failed, /boom/);
});

test("the permission screen names the device and what Claudex sees", () => {
  const markup = html(
    createElement(PermissionScreen, {
      kind: "ios",
      device: device("iPhone 17", "booted", "iOS 27.0"),
      busy: false,
      onCancel: () => {},
      onContinue: () => {},
    }),
  );
  assert.match(markup, /Let Claudex use this simulator\?/);
  assert.match(markup, /iPhone 17 \(iOS 27\.0\)/);
  assert.match(markup, /Don’t sign in to real accounts/);
  assert.match(markup, />Cancel</);
  assert.match(markup, />Continue</);
});

test("the quiet screens", () => {
  assert.match(
    html(createElement(Checking, { kind: "ios" })),
    /Checking your simulator setup…/,
  );
  assert.match(
    html(createElement(Checking, { kind: "android" })),
    /Checking your Android setup…/,
  );
  assert.match(
    html(createElement(Working, { text: "Shutting down the simulator…" })),
    /Shutting down the simulator…/,
  );
  assert.match(
    html(
      createElement(Unavailable, { text: "The iOS Simulator requires macOS." }),
    ),
    /requires macOS/,
  );
});

test("the device menu lists Booted and Available (will boot), or says there is none", () => {
  const entries = deviceEntries(
    "ios",
    [device("A", "shutdown"), device("B", "booted")],
    "B",
    () => {},
  );
  assert.deepEqual(
    entries.map((entry) =>
      "heading" in entry
        ? entry.heading
        : "separator" in entry
          ? "-"
          : `${entry.label}${entry.checked ? " ✓" : ""}`,
    ),
    ["Booted", "B ✓", "-", "Available (will boot)", "A"],
  );
  const none = deviceEntries("android", [], undefined, () => {});
  assert.equal("heading" in none[0] && none[0].heading, "No emulators found");
});

test("the attached device draws its picture, notices and controls", () => {
  const props = {
    kind: "android" as const,
    device: { ...device("Pixel 9", "booted"), kind: "android" as const },
    devices: [],
    screen: { dataUrl: "data:image/jpeg;base64,AAAA", width: 100, height: 200 },
    notices: [
      {
        key: "a",
        text: "You can use this emulator yourself, but Claudex can’t.",
        action: { label: "Let Claudex use it", run: () => {} },
      },
    ],
    onSwitch: () => {},
    onInput: () => {},
    onShutdown: () => {},
    onDetach: () => {},
  };
  const markup = html(createElement(DeviceView, props));
  assert.match(
    markup,
    /Simulator touch surface\. Click to focus, then type to send keystrokes/,
  );
  assert.match(markup, /src="data:image\/jpeg;base64,AAAA"/);
  for (const label of [
    "Back",
    "Home",
    "Recents",
    "Lock",
    "Zoom out",
    "Zoom to fit",
    "Physical size",
    "Zoom in",
  ])
    assert.match(markup, new RegExp(`aria-label="${label}"`));
  // Shut down and Detach live in the device menu now, not on the control bar.
  assert.doesNotMatch(markup, /Shut down|Detach/);
  assert.match(markup, />Let Claudex use it</);
  // Fitted to start with; Physical size needs the device's density.
  assert.match(markup, /aria-label="Zoom to fit" aria-pressed="true"/);
  assert.match(
    markup,
    /aria-label="Physical size" aria-pressed="false" aria-disabled="true"/,
  );
  const ios = html(
    createElement(DeviceView, {
      ...props,
      kind: "ios",
      device: device("iPhone 17", "booted"),
      notices: [],
    }),
  );
  assert.doesNotMatch(ios, /aria-label="Back"|aria-label="Recents"/);
  const waiting = html(createElement(DeviceView, { ...props, screen: null }));
  assert.match(waiting, /Loading the emulator…/);
  // Nothing to zoom until the picture is drawn.
  assert.match(
    waiting,
    /aria-label="Zoom to fit" aria-pressed="false" aria-disabled="true"/,
  );
});

test("Settings has Mobile simulators only on a desktop that can run one", () => {
  const section = (platform: string, settings = defaultSettings) =>
    html(
      createElement(MobileSimulatorsSection, {
        settings,
        save: () => {},
        platform: platform as NodeJS.Platform,
      }),
    );
  const mac = section("darwin");
  assert.match(mac, /Mobile simulators/);
  assert.match(mac, /iOS Simulator/);
  assert.match(mac, /Android emulators on this Mac/);
  assert.equal(
    (mac.match(/capturing screenshots and recordings/g) ?? []).length,
    2,
  );
  const windows = section("win32");
  assert.doesNotMatch(windows, /iOS Simulator/);
  assert.match(windows, /on this computer/);
  assert.match(windows, /capturing screenshots and recordings/);
  assert.equal(section("linux"), "");
  assert.match(
    section("darwin", { ...defaultSettings, iosSimulatorAccess: false }),
    /aria-checked="false"/,
  );
});

test("the device picker shows the name over the OS version, or what it is doing", () => {
  const props = {
    kind: "ios" as const,
    device: device("iPhone 17 Pro Max", "booted", "iOS 27.0"),
    devices: [],
    screen: null,
    notices: [],
    onSwitch: () => {},
    onInput: () => {},
    onShutdown: () => {},
    onDetach: () => {},
  };
  const markup = html(createElement(DeviceView, props));
  assert.match(markup, /aria-label="Choose simulator"/);
  assert.match(
    markup,
    />iPhone 17<\/span><span class="sim-picker-tail"> Pro Max</,
  );
  assert.match(markup, /class="sim-picker-detail">iOS 27\.0</);
  const busy = html(
    createElement(DeviceView, { ...props, busyLabel: "Booting…" }),
  );
  assert.match(busy, /aria-label="Choose simulator"/);
  assert.match(busy, />Booting…</);
  assert.match(busy, /aria-disabled="true"/);
  const android = html(
    createElement(DeviceView, { ...props, kind: "android" }),
  );
  assert.match(android, /aria-label="Choose emulator"/);
});

test("the device menu ends with a separator, Detach and Shut down {name}", () => {
  const entries = deviceMenuFooter({
    kind: "android",
    name: "Pixel 9",
    disabled: false,
    onDetach: () => {},
    onShutdown: () => {},
  });
  assert.deepEqual(
    entries.map((entry) => ("label" in entry ? entry.label : "-")),
    ["-", "Detach emulator", "Shut down Pixel 9"],
  );
  const ios = deviceMenuFooter({
    kind: "ios",
    name: "iPhone 17",
    disabled: true,
    onDetach: () => {},
    onShutdown: () => {},
  });
  assert.equal("label" in ios[1] && ios[1].label, "Detach simulator");
  assert.ok(ios.every((entry) => !("label" in entry) || entry.disabled));
});

test("the attach screen says a simulator was shut down in place of the boot hint", () => {
  const markup = html(
    createElement(AttachScreen, {
      kind: "ios",
      devices: [device("iPhone 17", "shutdown", "iOS 27.0")],
      notice: "This simulator was shut down. Attach it again to start it.",
      onAttach: () => {},
    }),
  );
  assert.match(
    markup,
    /This simulator was shut down\. Attach it again to start it\./,
  );
  assert.doesNotMatch(markup, /Shut-down devices boot automatically/);
});

test("device rows: right-click actions by state, a busy row says what it is doing, and name rules", async () => {
  const { deviceActions, RenameDeviceDialog } =
    await import("../../src/simulators/SimulatorScreens");
  const { deviceNameProblem } = await import("../../shared/simulators");
  assert.deepEqual(deviceActions("ios", true), [
    "shutdown",
    "restart",
    "rename",
  ]);
  assert.deepEqual(deviceActions("ios", false), ["start", "rename"]);
  assert.deepEqual(deviceActions("android", true), ["shutdown", "restart"]);
  const calls: string[] = [];
  const entries = deviceEntries(
    "ios",
    [device("A", "shutdown"), device("B", "booted")],
    "B",
    () => {},
    {
      busy: { A: "start" },
      onAction: (d, action) => calls.push(`${action} ${d.name}`),
    },
  );
  const rows = entries.filter((e) => "label" in e) as Extract<
    (typeof entries)[number],
    { label: string }
  >[];
  const a = rows.find((r) => r.label.startsWith("A"))!;
  const b = rows.find((r) => r.label.startsWith("B"))!;
  assert.equal(a.disabled, true);
  assert.equal(a.title, "Starting");
  assert.equal(a.contextMenu, undefined);
  assert.deepEqual(
    b.contextMenu!.map((e) => "label" in e && e.label),
    ["Shut down", "Restart", "Rename…"],
  );
  (b.contextMenu![1] as { onSelect: () => void }).onSelect();
  assert.deepEqual(calls, ["restart B"]);
  assert.equal(deviceNameProblem("-x"), "A name can’t start with a hyphen.");
  assert.equal(
    deviceNameProblem("a".repeat(65)),
    "Use 64 characters or fewer.",
  );
  assert.equal(
    deviceNameProblem("a​b"),
    "A name can’t contain hidden characters. Some emoji include them.",
  );
  assert.equal(deviceNameProblem("iPhone 17 Pro"), undefined);
  const dialog = html(
    createElement(RenameDeviceDialog, {
      initialName: "iPhone",
      onRename() {},
      onClose() {},
    }),
  );
  assert.match(dialog, /Rename simulator/);
  assert.match(dialog, /value="iPhone"/);
});
