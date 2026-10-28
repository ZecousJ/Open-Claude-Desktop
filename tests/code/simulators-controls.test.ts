import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  controlShortcut,
  filterLogs,
  FrameClock,
  logLevelName,
  logLevelTag,
  logTime,
  mergeLogs,
  scopeColumnChars,
  clampScopeWidth,
} from "../../src/simulators/simulator-controls";
import { DeviceView } from "../../src/simulators/SimulatorDevice";
import { type DeviceTools } from "../../src/simulators/DeviceControls";
import { ControlBar } from "../../src/simulators/SimulatorControlBar";
import { LogsDrawer } from "../../src/simulators/SimulatorLogs";
import { CaptureThumbnail } from "../../src/simulators/CaptureThumbnail";
import type {
  SimulatorDevice,
  SimulatorLogEntry,
} from "../../shared/simulators";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(node);

const key = (key: string, extra: Partial<Record<string, boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

const entry = (
  seq: number,
  level: SimulatorLogEntry["level"],
  message: string,
  subsystem?: string,
): SimulatorLogEntry => ({
  seq,
  ts: 0,
  level,
  process: "Demo",
  pid: 1,
  subsystem,
  message,
});

const tools: DeviceTools = {
  saveScreenshot: async () => ({ kind: "screenshot", path: "/d/a.png" }),
  startRecording: async () => {},
  stopRecording: async () => ({ kind: "recording", path: "/d/a.mp4" }),
  captures: {
    copyPath: async () => true,
    reveal: () => {},
    remove: async () => true,
  },
  savedNotice: () => {},
  appearance: async () => "light",
  softwareKeyboard: async () => false,
  clipboard: async () => 0,
  readLogs: async () => ({ entries: [], captureId: 1 }),
  stopLogs: () => {},
  report: () => {},
  revealLabel: "Show in Finder",
};

const props = (kind: "ios" | "android") => ({
  kind,
  device: {
    kind,
    id: kind === "ios" ? "iPhone 17" : "emulator-5554",
    name: kind === "ios" ? "iPhone 17" : "Pixel 9",
    state: "booted",
  } as SimulatorDevice,
  devices: [],
  screen: { dataUrl: "data:image/jpeg;base64,AAAA", width: 100, height: 200 },
  notices: [],
  onSwitch: () => {},
  onInput: () => {},
  onShutdown: () => {},
  onDetach: () => {},
});

test("screen shortcuts: ⌘S saves, ⇧⌘H is Home, ⇧⌘R Recents on Android, ⇧⌘A Appearance on iOS", () => {
  assert.equal(
    controlShortcut(key("s", { metaKey: true }), true, "ios"),
    "screenshot",
  );
  assert.equal(
    controlShortcut(key("s", { ctrlKey: true }), false, "ios"),
    "screenshot",
  );
  assert.equal(
    controlShortcut(key("s", { ctrlKey: true }), true, "ios"),
    undefined,
  );
  assert.equal(
    controlShortcut(key("H", { metaKey: true, shiftKey: true }), true, "ios"),
    "home",
  );
  assert.equal(
    controlShortcut(
      key("R", { metaKey: true, shiftKey: true }),
      true,
      "android",
    ),
    "recents",
  );
  assert.equal(
    controlShortcut(key("R", { metaKey: true, shiftKey: true }), true, "ios"),
    undefined,
  );
  assert.equal(
    controlShortcut(key("A", { metaKey: true, shiftKey: true }), true, "ios"),
    "appearance",
  );
  assert.equal(
    controlShortcut(
      key("A", { metaKey: true, shiftKey: true }),
      true,
      "android",
    ),
    undefined,
  );
  // ⌘R is the window's Reload: the screen never takes it.
  assert.equal(
    controlShortcut(key("r", { metaKey: true }), true, "ios"),
    undefined,
  );
  assert.equal(controlShortcut(key("s"), true, "ios"), undefined);
});

test("the frame counter counts new pictures over two seconds and goes idle", () => {
  const clock = new FrameClock();
  assert.equal(clock.read(0), null);
  clock.frame(0);
  clock.frame(500);
  clock.frame(1000);
  clock.frame(1500);
  assert.equal(clock.read(1600), 2);
  assert.equal(clock.read(5000), "idle");
  clock.reset();
  assert.equal(clock.read(5000), null);
});

test("log lines: levels, Android's Warning, filters, merge and the scope column", () => {
  assert.equal(logLevelName("default", "ios"), "Default");
  assert.equal(logLevelName("default", "android"), "Warning");
  assert.equal(logLevelTag("default", "ios"), "");
  assert.equal(logLevelTag("default", "android"), "warn");
  assert.equal(logLevelTag("error", "ios"), "error");
  const lines = [
    entry(1, "debug", "hello"),
    entry(2, "info", "network up", "com.example.net"),
    entry(3, "error", "boom"),
  ];
  assert.deepEqual(
    filterLogs(lines, "info", "").map((line) => line.seq),
    [2, 3],
  );
  assert.deepEqual(
    filterLogs(lines, "debug", "EXAMPLE.NET").map((line) => line.seq),
    [2],
  );
  assert.deepEqual(
    filterLogs(lines, "debug", "demo").map((line) => line.seq),
    [1, 2, 3],
  );
  let held = mergeLogs(
    { captureId: undefined, entries: [], dropped: 0 },
    1,
    lines,
    2,
  );
  assert.deepEqual(
    held.entries.map((line) => line.seq),
    [2, 3],
  );
  assert.equal(held.dropped, 1);
  // Lines already held are not added twice; a new capture starts over.
  assert.equal(mergeLogs(held, 1, [lines[2]], 2), held);
  held = mergeLogs(held, 2, [entry(1, "info", "again")], 2);
  assert.deepEqual(
    held.entries.map((line) => line.message),
    ["again"],
  );
  assert.equal(held.dropped, 0);
  assert.equal(scopeColumnChars([]), 6);
  assert.equal(scopeColumnChars(["x".repeat(40)]), 30);
  assert.match(
    logTime(Date.UTC(2026, 9, 12, 1, 2, 3, 45)),
    /^\d\d:02:03\.045$/,
  );
});

test("the device has the Simulator menus and the full control bar with tools", () => {
  const ios = html(createElement(DeviceView, { ...props("ios"), tools }));
  assert.match(ios, /role="menubar" aria-label="Simulator menus"/);
  for (const label of ["Edit", "Device", "View"])
    assert.match(ios, new RegExp(`>${label}</button>`));
  for (const label of [
    "Save screenshot",
    "Record video",
    "Show logs",
    "Home",
    "Lock",
  ])
    assert.match(ios, new RegExp(`aria-label="${label}"`));
  assert.doesNotMatch(
    ios,
    /aria-label="(Back|Recents|Annotate|Select element)"/,
  );
  assert.match(ios, /aria-label="Rotate right"/);
  const android = html(
    createElement(DeviceView, { ...props("android"), tools }),
  );
  assert.match(android, />View<\/button>/);
  // Android: Device has the on-screen keyboard; there is no Edit menu.
  assert.match(android, />Device<\/button>/);
  assert.doesNotMatch(android, />Edit<\/button>/);
  assert.match(android, /aria-label="Save screenshot"/);
  assert.match(android, /aria-label="Show logs"/);
  // Only the iOS Simulator records.
  assert.doesNotMatch(android, /aria-label="Record video"/);
  // Without tools the bar has only the device's buttons.
  const bare = html(createElement(DeviceView, props("ios")));
  assert.doesNotMatch(bare, /Save screenshot|Show logs|>Edit</);
  assert.match(bare, />View<\/button>/);
});

test("while recording the bar shows the time and Stop recording", () => {
  const markup = html(
    createElement(ControlBar, {
      kind: "ios",
      disabled: false,
      busy: false,
      recordingStartedAt: Date.now() - 65_000,
      logsOpen: true,
      canRecord: true,
      onButton: () => {},
      onScreenshot: () => {},
      onToggleRecording: () => {},
      onToggleLogs: () => {},
    }),
  );
  assert.match(markup, /role="timer" aria-label="Recording time"/);
  assert.match(markup, />01:0[45]</);
  assert.match(markup, /aria-label="Stop recording"/);
  assert.match(markup, /aria-label="Hide logs" aria-pressed="true"/);
});

test("the log drawer's head and columns", () => {
  const markup = html(
    createElement(LogsDrawer, {
      kind: "ios",
      read: async () => ({ entries: [], captureId: 1 }),
      stop: () => {},
      fullHeight: false,
      onToggleFullHeight: () => {},
      onClose: () => {},
    }),
  );
  assert.match(markup, /aria-label="Simulator logs"/);
  assert.match(markup, /aria-label="Min level: Info"/);
  assert.match(markup, /placeholder="Filter" aria-label="Filter log lines"/);
  assert.match(markup, />0 lines</);
  for (const label of [
    "Full height",
    "Clear view",
    "Close logs",
    "Resize the logs drawer",
    "Resize the scope column",
  ])
    assert.match(markup, new RegExp(`aria-label="${label}"`));
  for (const column of ["Time", "Level", "Scope", "Message"])
    assert.match(markup, new RegExp(`<span>${column}</span>`));
  assert.match(markup, /Loading logs…/);
  assert.match(markup, /aria-valuemin="48" aria-valuemax="640"/);
  assert.match(markup, /aria-valuetext="Fits the widest label"/);
});

test("scope resizing follows the official 48–640 pixel bounds and rounds finite widths", () => {
  assert.equal(clampScopeWidth(0), 48);
  assert.equal(clampScopeWidth(900), 640);
  assert.equal(clampScopeWidth(120.6), 121);
  assert.equal(clampScopeWidth(Infinity), 48);
  assert.equal(clampScopeWidth(NaN), 48);
});

test("a saved screenshot's corner thumbnail names the file", () => {
  const markup = html(
    createElement(CaptureThumbnail, {
      capture: {
        kind: "screenshot",
        path: "/Users/me/Desktop/Simulator Screenshot - iPhone 17 - 2026-10-12 at 09.41.07.png",
        thumbnail: {
          dataUrl: "data:image/jpeg;base64,BB",
          width: 110,
          height: 240,
        },
      },
      actions: tools.captures,
      retiring: false,
      revealLabel: "Show in Finder",
      onDismiss: () => {},
      onReturnFocus: () => {},
    }),
  );
  assert.match(
    markup,
    /aria-label="Screenshot saved: Simulator Screenshot - iPhone 17 - 2026-10-12 at 09\.41\.07\.png"/,
  );
  assert.match(markup, /src="data:image\/jpeg;base64,BB"/);
});

test("side-button shortcuts: ⌘L locks, ⌘↑ ⌘↓ change the volume on Android", () => {
  assert.equal(
    controlShortcut(key("l", { metaKey: true }), true, "ios"),
    "lock",
  );
  assert.equal(
    controlShortcut(key("ArrowUp", { metaKey: true }), true, "android"),
    "volumeUp",
  );
  assert.equal(
    controlShortcut(key("ArrowDown", { ctrlKey: true }), false, "android"),
    "volumeDown",
  );
  assert.equal(
    controlShortcut(key("ArrowUp", { metaKey: true }), true, "ios"),
    undefined,
  );
});

test("Back and rotation shortcuts match the official platform gates", () => {
  assert.equal(
    controlShortcut(
      key("b", { metaKey: true, shiftKey: true }),
      true,
      "android",
    ),
    "back",
  );
  assert.equal(
    controlShortcut(key("b", { metaKey: true, shiftKey: true }), true, "ios"),
    undefined,
  );
  assert.equal(
    controlShortcut(key("ArrowRight", { metaKey: true }), true, "ios"),
    "rotate",
  );
  assert.equal(
    controlShortcut(key("ArrowRight", { metaKey: true }), true, "android"),
    undefined,
  );
});

test("foldable controls expose presets, percentage and degree readout", () => {
  const markup = html(
    createElement(ControlBar, {
      kind: "android",
      disabled: false,
      busy: false,
      recordingStartedAt: null,
      logsOpen: false,
      canRecord: false,
      onButton: () => {},
      onScreenshot: () => {},
      onToggleRecording: () => {},
      onToggleLogs: () => {},
      hinge: { percent: 50, onChange: () => {}, onCommit: () => {} },
    }),
  );
  assert.match(markup, /aria-label="Device pose"/);
  assert.match(markup, /aria-label="Half open" aria-pressed="true"/);
  assert.match(markup, /aria-label="Closed"/);
  assert.match(markup, /aria-label="Open"/);
  assert.match(markup, /aria-valuetext="50% open, 90 degrees"/);
  assert.match(markup, />50%</);
  assert.match(markup, /aria-label="Volume up"/);
  assert.match(markup, /aria-label="Volume down"/);
});

test("a crash line is what the log drawer's Go to crash finds", async () => {
  const { isCrashEntry } = await import("../../src/simulators/SimulatorLogs");
  const entry = (level: SimulatorLogEntry["level"], message: string) => ({
    seq: 1,
    ts: 0,
    level,
    process: "app",
    pid: 1,
    message,
  });
  assert.equal(isCrashEntry(entry("error", "FATAL EXCEPTION: main")), true);
  assert.equal(
    isCrashEntry(
      entry("fault", "Terminating app due to uncaught exception 'NSRange'"),
    ),
    true,
  );
  assert.equal(isCrashEntry(entry("info", "crashed")), false);
  assert.equal(isCrashEntry(entry("error", "request failed")), false);
  assert.equal(isCrashEntry(entry("crash", "Incident Identifier: ABC")), true);
});
