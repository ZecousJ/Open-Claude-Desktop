import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import { registerSimulatorHandlers } from "../../electron/ipc/simulators";
import {
  LogCapture,
  logTimestamp,
  parseIosLogLine,
  parseLogcatLine,
} from "../../electron/simulators/logs";
import type { SimulatorPlatform } from "../../electron/simulators/platform";
import { openPolicy } from "../../shared/client-policy";
import {
  captureBaseName,
  logLevelAtLeast,
  logScope,
  logScopeFull,
} from "../../shared/simulators";
import {
  FakeProcess,
  FakeRunner,
  fakeProbe,
  fakeScaler,
  iosList,
  png,
} from "../support/simulators-fakes";

const udid = "33333333-3333-3333-3333-333333333333";

/** Waits (a few event-loop turns at a time) until `ready` holds. */
async function until(ready: () => boolean) {
  for (let turn = 0; turn < 200 && !ready(); turn++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(ready(), "the condition came true");
}

function setup(reply?: (file: string, args: string[]) => unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simulators-media-"));
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(desktop);
  const clipboard = { text: "" };
  const revealed: string[] = [];
  const runner = new FakeRunner((file, args) => {
    const custom = reply?.(file, args);
    if (custom !== undefined) return custom as string | Buffer;
    if (args[1] === "list") return iosList;
    if (args[1] === "io" && args[3] === "screenshot") {
      fs.writeFileSync(String(args.at(-1)), png(1206, 2622));
      return "";
    }
    return "";
  });
  const platform: SimulatorPlatform = {
    environment: {
      platform: "darwin",
      env: { ANDROID_HOME: "/sdk" },
      home: root,
      arch: "arm64",
    },
    probe: fakeProbe({ "/sdk/platform-tools/adb": true }),

    runner,
    scaler: fakeScaler,
    ask: async () => "allow",
    openExternal: async () => undefined,
    captureFolder: () => desktop,
    clipboard: {
      read: async () => clipboard.text,
      write: (text) => void (clipboard.text = text),
    },
    reveal: (file) => void revealed.push(file),
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const selectedAttachments = new Map();
  registerSimulatorHandlers(
    (name, fn) => void handlers.set(name, fn),
    {
      store: { root, settings: {} },
      policy: () => openPolicy,
      selectedAttachments,
    } as unknown as AppContext,
    async () => platform,
  );
  const call = (name: string, ...args: unknown[]) => {
    const handler = handlers.get(name);
    assert.ok(handler, `${name} is registered`);
    return handler(...args);
  };
  return { call, runner, desktop, clipboard, revealed, selectedAttachments };
}

test("capture names follow the original's pattern and drop characters a file name can't hold", () => {
  const date = new Date(2026, 9, 12, 9, 4, 7);
  assert.equal(
    captureBaseName("Simulator Screenshot", "iPhone 17 Pro", date),
    "Simulator Screenshot - iPhone 17 Pro - 2026-10-12 at 09.04.07",
  );
  assert.equal(
    captureBaseName("Simulator Recording", ' a/b:c "d" ', date),
    "Simulator Recording - a b c d - 2026-10-12 at 09.04.07",
  );
  assert.equal(
    captureBaseName("Simulator Screenshot", "///", date),
    "Simulator Screenshot - Device - 2026-10-12 at 09.04.07",
  );
});

test("Save screenshot writes a PNG to the Desktop, a second one gets its own name", async () => {
  const { call, desktop } = setup();
  const first = await call("simulatorSaveScreenshot", "ios", udid);
  const second = await call("simulatorSaveScreenshot", "ios", udid);
  assert.equal(first.kind, "screenshot");
  assert.equal(path.dirname(first.path), desktop);
  assert.match(
    path.basename(first.path),
    /^Simulator Screenshot - iPhone 17 - \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d( 2)?\.png$/,
  );
  assert.notEqual(first.path, second.path);
  assert.ok(fs.existsSync(first.path) && fs.existsSync(second.path));
  // The corner thumbnail is at most 240 px on its longer edge.
  assert.deepEqual([first.thumbnail.width, first.thumbnail.height], [110, 240]);
  assert.match(first.thumbnail.dataUrl, /^data:image\/jpeg;base64,/);
});

test("a capture's menu acts only on files saved here and unchanged since", async () => {
  const { call, revealed, selectedAttachments } = setup();
  const shot = await call("simulatorSaveScreenshot", "ios", udid);
  assert.equal(await call("simulatorCaptureAction", shot.path, "reveal"), true);
  assert.deepEqual(revealed, [shot.path]);
  const attachment = await call("simulatorAttachCapture", shot.path);
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.name, path.basename(shot.path));
  assert.ok(selectedAttachments.has(attachment.id));
  assert.equal(
    await call("simulatorCaptureAction", "/etc/hosts", "delete"),
    false,
  );
  await assert.rejects(() =>
    call("simulatorCaptureAction", "relative.png", "reveal"),
  );
  await assert.rejects(() => call("simulatorAttachCapture", "/etc/hosts"));
  assert.equal(await call("simulatorCaptureAction", shot.path, "delete"), true);
  assert.equal(fs.existsSync(shot.path), false);
  assert.equal(
    await call("simulatorCaptureAction", shot.path, "reveal"),
    false,
  );
});

test("Record video runs simctl recordVideo, SIGINT finishes it and the movie moves to the Desktop", async () => {
  const { call, runner, desktop } = setup();
  const recording = call("simulatorStartRecording", "ios", udid);
  // The recorder counts as running once it hasn't exited for a moment.
  await recording;
  const process = runner.started.at(-1) as FakeProcess;
  assert.deepEqual(process.args.slice(0, 6), [
    "simctl",
    "io",
    udid,
    "recordVideo",
    "--codec=h264",
    "--force",
  ]);
  const staged = process.args[6];
  await assert.rejects(
    () => call("simulatorStartRecording", "ios", udid),
    /already being recorded/,
  );
  process.onKill = (signal) => {
    if (signal !== "SIGINT") return;
    fs.writeFileSync(staged, "movie");
    process.finish(0);
  };
  const capture = await call("simulatorStopRecording", "ios", udid);
  assert.deepEqual(process.signals, ["SIGINT"]);
  assert.equal(capture.kind, "recording");
  assert.equal(path.dirname(capture.path), desktop);
  assert.match(
    path.basename(capture.path),
    /^Simulator Recording - iPhone 17 - .*\.mp4$/,
  );
  assert.equal(fs.readFileSync(capture.path, "utf8"), "movie");
  assert.equal(fs.existsSync(path.dirname(staged)), false);
  // A recording can't be attached (Claudex attachments have no video).
  await assert.rejects(() => call("simulatorAttachCapture", capture.path));
  await assert.rejects(
    () => call("simulatorStopRecording", "ios", udid),
    /No recording/,
  );
});

test("a recorder that exits at once is an error, and Android has no recording", async () => {
  const { call, runner } = setup();
  const starting = call("simulatorStartRecording", "ios", udid);
  await until(() => runner.started.length > 0);
  const process = runner.started.at(-1) as FakeProcess;
  process.errors = "Error: a recording is already in progress";
  process.finish(1);
  await assert.rejects(() => starting, /already has a recording in progress/);
  await assert.rejects(
    () => call("simulatorStartRecording", "android", "emulator-5554"),
    /can’t be recorded/,
  );
});

test("Appearance reads and sets simctl ui appearance", async () => {
  let current = "light";
  const { call, runner } = setup((file, args) => {
    if (args[1] !== "ui") return undefined;
    if (args[4]) current = args[4];
    return `${current}\n`;
  });
  assert.equal(await call("simulatorAppearance", "ios", udid), "light");
  assert.equal(await call("simulatorAppearance", "ios", udid, "dark"), "dark");
  assert.ok(
    runner.lines("xcrun").includes(`xcrun simctl ui ${udid} appearance dark`),
  );
  await assert.rejects(() => call("simulatorAppearance", "ios", udid, "sepia"));
});

test("Get clipboard and Send clipboard move text between the Mac and the simulator", async () => {
  const { call, runner, clipboard } = setup((file, args) =>
    args[1] === "pbpaste" ? "from the phone" : undefined,
  );
  assert.equal(await call("simulatorClipboard", "ios", udid, "get"), 14);
  assert.equal(clipboard.text, "from the phone");
  clipboard.text = "from the Mac";
  assert.equal(await call("simulatorClipboard", "ios", udid, "send"), 12);
  const sent = runner.calls.find((item) => item.args[1] === "pbcopy");
  assert.equal(sent?.options?.input, "from the Mac");
  clipboard.text = "";
  assert.equal(await call("simulatorClipboard", "ios", udid, "send"), 0);
  await assert.rejects(() => call("simulatorClipboard", "ios", udid, "swap"));
});

test("Show logs streams the unified log and returns lines after the last one read", async () => {
  const { call, runner } = setup();
  const empty = await call("simulatorLogs", "ios", udid, 0);
  assert.deepEqual(empty.entries, []);
  const stream = runner.started.at(-1) as FakeProcess;
  assert.deepEqual(stream.args, [
    "simctl",
    "spawn",
    udid,
    "log",
    "stream",
    "--style",
    "ndjson",
    "--level",
    "debug",
  ]);
  stream.emit("Filtering the log data using …");
  stream.emit(
    JSON.stringify({
      eventType: "logEvent",
      messageType: "Error",
      eventMessage: "boom",
      processImagePath: "/Apps/Demo.app/Demo",
      processID: 42,
      subsystem: "com.example.demo",
      category: "network",
      timestamp: "2026-10-12 09:41:07.123456+0800",
    }),
  );
  const batch = await call("simulatorLogs", "ios", udid, 0);
  assert.equal(batch.entries.length, 1);
  assert.deepEqual(
    { ...batch.entries[0] },
    {
      seq: 1,
      ts: Date.parse("2026-10-12T01:41:07.123Z"),
      level: "error",
      process: "Demo",
      pid: 42,
      subsystem: "com.example.demo",
      category: "network",
      message: "boom",
    },
  );
  assert.deepEqual((await call("simulatorLogs", "ios", udid, 1)).entries, []);
  // One stream per device; Close logs stops it.
  assert.equal(runner.started.length, 1);
  await call("simulatorLogsStop", "ios", udid);
  assert.deepEqual(stream.signals, ["SIGTERM"]);
  await call("simulatorLogs", "ios", udid, 0);
  assert.equal(runner.started.length, 2);
});

test("a log stream that ends says why, and opening again restarts it", async () => {
  const { call, runner } = setup();
  await call("simulatorLogs", "ios", udid, 0);
  const stream = runner.started.at(-1) as FakeProcess;
  stream.errors = "Unable to stream: device is shut down";
  stream.finish(1);
  await stream.exited;
  const ended = await call("simulatorLogs", "ios", udid, 5);
  assert.equal(ended.ended, "Unable to stream: device is shut down");
  const again = await call("simulatorLogs", "ios", udid, 0);
  assert.equal(again.ended, undefined);
  assert.ok(again.captureId > ended.captureId);
});

test("logcat lines read as Android levels, tags as the scope", () => {
  const now = Date.now();
  const entry = parseLogcatLine(
    "2026-10-12 09:41:07.123  1234  1250 W ActivityManager: Slow operation",
    now,
  );
  assert.equal(entry?.level, "default");
  assert.equal(entry?.pid, 1234);
  assert.equal(entry?.subsystem, "ActivityManager");
  assert.equal(entry?.message, "Slow operation");
  assert.equal(parseLogcatLine("--------- beginning of main", now), null);
  assert.equal(
    parseLogcatLine("2026-10-12 09:41:07.123  1 2 E Tag: x", now)?.level,
    "error",
  );
});

test("iOS log lines: non-events are skipped, long messages cut, unknown levels are Default", () => {
  const now = 5;
  assert.equal(parseIosLogLine("not json", now), null);
  assert.equal(
    parseIosLogLine(JSON.stringify({ eventType: "activityCreateEvent" }), now),
    null,
  );
  const long = parseIosLogLine(
    JSON.stringify({ eventMessage: "x".repeat(5000), messageType: "Odd" }),
    now,
  );
  assert.equal(long?.message.length, 4096);
  assert.equal(long?.level, "default");
  assert.equal(long?.ts, now);
  assert.equal(
    logTimestamp("2026-10-12 09:41:07+0000", 0),
    Date.parse("2026-10-12T09:41:07Z"),
  );
});

test("a capture keeps the latest lines and hands out the newest ones when far behind", () => {
  const process = new FakeProcess("x", []);
  const capture = new LogCapture(
    1,
    process,
    (line) => ({ ts: 0, level: "info", process: "p", pid: 1, message: line }),
    () => 0,
    3,
  );
  for (const line of ["a", "b", "c", "d"]) process.emit(line);
  assert.deepEqual(
    capture.read(0).map((entry) => [entry.seq, entry.message]),
    [
      [2, "b"],
      [3, "c"],
      [4, "d"],
    ],
  );
  assert.deepEqual(
    capture.read(0, 2).map((entry) => entry.seq),
    [3, 4],
  );
  assert.deepEqual(capture.read(4), []);
});

test("log scope and levels", () => {
  assert.equal(
    logScope({ subsystem: "com.apple.xpc", category: "connection" }),
    "xpc:connection",
  );
  assert.equal(
    logScopeFull({ subsystem: "com.apple.xpc", category: "connection" }),
    "com.apple.xpc:connection",
  );
  assert.equal(logScope({}), "");
  assert.equal(logLevelAtLeast("error", "info"), true);
  assert.equal(logLevelAtLeast("debug", "info"), false);
});

const adbDevices =
  "List of devices attached\nemulator-5554          device product:sdk_gphone64 transport_id:1\n";

test("Android: Show on-screen keyboard reads and sets show_ime_with_hard_keyboard", async () => {
  let value = "null";
  const { call, runner } = setup((file, args) => {
    if (file !== "/sdk/platform-tools/adb") return undefined;
    if (args[0] === "devices") return adbDevices;
    if (args.includes("show_ime_with_hard_keyboard")) {
      if (args[4] === "put") value = String(args.at(-1));
      return `${value}\n`;
    }
    return "";
  });
  assert.equal(
    await call("simulatorSoftwareKeyboard", "android", "emulator-5554"),
    false,
  );
  assert.equal(
    await call("simulatorSoftwareKeyboard", "android", "emulator-5554", true),
    true,
  );
  assert.ok(
    runner
      .lines("/sdk/platform-tools/adb")
      .includes(
        "/sdk/platform-tools/adb -s emulator-5554 shell settings put secure show_ime_with_hard_keyboard 1",
      ),
  );
  assert.equal(await call("simulatorSoftwareKeyboard", "ios", udid), true);
});

test("Android: Slow animations sets the three animation scales to 10× and reads the animator one", async () => {
  const scales: Record<string, string> = {};
  const { call, runner } = setup((file, args) => {
    if (file !== "/sdk/platform-tools/adb") return undefined;
    if (args[0] === "devices") return adbDevices;
    const setting = args.find((arg) => arg.endsWith("_scale"));
    if (setting) {
      if (args[4] === "put") scales[setting] = String(args.at(-1));
      return `${scales[setting] ?? "1.0"}\n`;
    }
    return "";
  });
  assert.equal(
    await call("simulatorSlowAnimations", "android", "emulator-5554"),
    false,
  );
  assert.equal(
    await call("simulatorSlowAnimations", "android", "emulator-5554", true),
    true,
  );
  assert.deepEqual(scales, {
    window_animation_scale: "10",
    transition_animation_scale: "10",
    animator_duration_scale: "10",
  });
  assert.equal(
    await call("simulatorSlowAnimations", "android", "emulator-5554", false),
    false,
  );
  assert.ok(runner.lines("/sdk/platform-tools/adb").length > 0);
  await assert.rejects(
    call("simulatorSlowAnimations", "ios", udid),
    /animation speed/,
  );
});

test("Android: a foldable's hinge angle reads and sets the hinge sensor; others have none", async () => {
  let angle = "180.000000";
  let foldable = true;
  const { call } = setup((file, args) => {
    if (file !== "/sdk/platform-tools/adb") return undefined;
    if (args[0] === "devices") return adbDevices;
    if (args.includes("hinge-angle0")) {
      if (!foldable) return undefined;
      if (args.includes("set")) angle = String(args.at(-1));
      return `hinge-angle0 = ${angle}\n`;
    }
    return "";
  });
  assert.equal(await call("simulatorHinge", "android", "emulator-5554"), 180);
  assert.equal(
    await call("simulatorHinge", "android", "emulator-5554", 90),
    90,
  );
  foldable = false;
  assert.equal(await call("simulatorHinge", "android", "emulator-5554"), null);
});

test("Android: Show logs reads logcat in threadtime format", async () => {
  const { call, runner } = setup((file, args) =>
    file === "/sdk/platform-tools/adb" && args[0] === "devices"
      ? adbDevices
      : undefined,
  );
  await call("simulatorLogs", "android", "emulator-5554", 0);
  const stream = runner.started.at(-1) as FakeProcess;
  assert.equal(stream.file, "/sdk/platform-tools/adb");
  assert.deepEqual(stream.args.slice(0, 7), [
    "-s",
    "emulator-5554",
    "logcat",
    "-v",
    "threadtime",
    "-v",
    "year",
  ]);
  stream.emit("--------- beginning of main");
  stream.emit("2026-10-12 09:41:07.123  1234  1250 E AndroidRuntime: FATAL");
  const batch = await call("simulatorLogs", "android", "emulator-5554", 0);
  assert.equal(batch.entries.length, 1);
  assert.equal(batch.entries[0].level, "error");
  assert.equal(batch.entries[0].subsystem, "AndroidRuntime");
});

test("Annotate's screenshot is the full PNG in memory, named like a saved one", async () => {
  const { call, desktop } = setup();
  const before = fs.readdirSync(desktop).length;
  const shot = await call("simulatorCaptureScreenshot", "ios", udid);
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);
  assert.ok(shot.width > 0 && shot.height > 0);
  assert.match(
    shot.name,
    /^Simulator Screenshot - iPhone 17 - \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d$/,
  );
  // Nothing was written to the Desktop.
  assert.equal(fs.readdirSync(desktop).length, before);
});
