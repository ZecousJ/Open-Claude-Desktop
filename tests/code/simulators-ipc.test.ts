import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import { registerSimulatorHandlers } from "../../electron/ipc/simulators";
import {
  openSimulatorTarget,
  type SimulatorPlatform,
} from "../../electron/simulators/platform";
import { simulatorsMethods } from "../../shared/simulators-api";
import { webDomainRules } from "../../shared/web-bridge-methods";
import {
  FakeRunner,
  fakeProbe,
  fakeScaler,
  iosList,
} from "../support/simulators-fakes";

const udid = "33333333-3333-3333-3333-333333333333";

function platform(
  runner: FakeRunner,
  options: {
    answer?: "allow" | "cancel";
    files?: Record<string, string | string[] | true>;
  } = {},
): SimulatorPlatform & { opened: string[] } {
  const opened: string[] = [];
  return {
    environment: {
      platform: "darwin",
      env: {},
      home: "/Users/me",
      arch: "arm64",
    },
    probe: fakeProbe(options.files ?? {}),
    runner,
    scaler: fakeScaler,
    ask: async () => options.answer ?? "allow",
    openExternal: async (url) => void opened.push(url),
    captureFolder: () => os.tmpdir(),
    clipboard: { read: () => "", write: () => undefined },
    reveal: () => undefined,
    opened,
  };
}

function setup(
  settings: Record<string, unknown> = {},
  runner = new FakeRunner((file, args) => (args[1] === "list" ? iosList : "")),
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simulators-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const fake = platform(runner);
  registerSimulatorHandlers(
    (name, fn) => void handlers.set(name, fn),
    { store: { root, settings } } as unknown as AppContext,
    async () => fake,
  );
  const call = (name: string, ...args: unknown[]) => {
    const handler = handlers.get(name);
    assert.ok(handler, `${name} is registered`);
    return handler(...args);
  };
  return { call, handlers, root, runner, platform: fake };
}

test("every call of the domain has a handler, and the web has none of them", () => {
  const { handlers } = setup();
  assert.deepEqual([...handlers.keys()].sort(), [...simulatorsMethods].sort());
  assert.equal(webDomainRules.simulators.default, "absent");
});

test("rotation and edit input are validated and dispatched end to end", async () => {
  const { call, runner } = setup();
  const id = "33333333-3333-3333-3333-333333333333";
  await call("simulatorInput", "ios", id, { type: "rotate" });
  await call("simulatorInput", "ios", id, { type: "edit", action: "paste" });
  assert.match(runner.lines("/usr/bin/osascript").join("\n"), /key code 124/);
  assert.match(runner.lines("/usr/bin/osascript").join("\n"), /key code 9/);
  await assert.rejects(
    call("simulatorInput", "ios", id, { type: "edit", action: "anything" }),
  );
});

test("state reads the Settings switches", async () => {
  assert.deepEqual((await setup().call("simulatorsState")).ios, {
    supported: true,
    enabled: true,
  });
  const off = await setup({
    iosSimulatorAccess: false,
    androidEmulatorAccess: false,
  }).call("simulatorsState");
  assert.equal(off.ios.enabled, false);
  assert.equal(off.android.enabled, false);
});

test("iOS slow animations reads and toggles the native notification through IPC", async () => {
  const notification = "com.apple.UIKit.SimulatorSlowMotionAnimationState";
  let state = "0";
  const { call, runner } = setup(
    {},
    new FakeRunner((_file, args) => {
      if (args[1] === "list") return iosList;
      const set = args.indexOf("-s");
      if (set >= 0) state = args[set + 2];
      return args.includes("-g") ? `${notification} ${state}` : "";
    }),
  );
  assert.equal(await call("simulatorSlowAnimations", "ios", udid), false);
  assert.equal(await call("simulatorSlowAnimations", "ios", udid, true), true);
  assert.equal(
    await call("simulatorSlowAnimations", "ios", udid, false),
    false,
  );
  assert.ok(
    runner
      .lines("xcrun")
      .includes(
        `xcrun simctl spawn ${udid} notifyutil -s ${notification} 1 -p ${notification}`,
      ),
  );
  await assert.rejects(call("simulatorSlowAnimations", "ios", udid, "true"));
});

test("the pane lists devices, boots and shuts down, and checks what it is given", async () => {
  const { call, runner } = setup();
  const devices = await call("simulatorDevices", "ios");
  assert.equal(devices[0].name, "iPhone 17");
  await call("simulatorShutdown", "ios", udid);
  assert.ok(runner.lines("xcrun").includes(`xcrun simctl shutdown ${udid}`));
  await call("simulatorRename", "ios", udid, "My Phone");
  assert.ok(
    runner.lines("xcrun").includes(`xcrun simctl rename ${udid} My Phone`),
  );
  await assert.rejects(
    () => call("simulatorRename", "ios", udid, "-rf"),
    /hyphen/,
  );
  await assert.rejects(() => call("simulatorDevices", "windows"));
  await assert.rejects(
    () => call("simulatorBoot", "ios", "../../etc/passwd"),
    /Invalid device ID/,
  );
  await assert.rejects(() =>
    call("simulatorInput", "ios", udid, { type: "tap", x: 4, y: 0 }),
  );
  await assert.rejects(() =>
    call("simulatorInput", "ios", udid, {
      type: "tap",
      x: 0,
      y: 0,
      shell: "x",
    }),
  );
});

test("Allow in the pane is kept in the account's profile folder", async () => {
  const { call, root } = setup();
  assert.equal(await call("simulatorAccess", "ios", udid), false);
  await call("simulatorAllow", "ios", udid, true);
  assert.equal(await call("simulatorAccess", "ios", udid), true);
  const saved: string[] = JSON.parse(
    fs.readFileSync(path.join(root, "simulator-access.json"), "utf8"),
  );
  assert.equal(saved[0], `ios:${udid}`);
  assert.match(saved[1], /^tools-signature:[a-f0-9]{64}$/);
  await assert.rejects(() => call("simulatorAllow", "ios", udid, "yes"));
});

test("the setup screens' buttons open Xcode, the App Store and Android Studio's page", async () => {
  const runner = new FakeRunner((file) =>
    file === "xcode-select"
      ? "/Applications/Xcode.app/Contents/Developer\n"
      : "",
  );
  const fake = platform(runner, { files: { "/Applications/Xcode.app": [] } });
  assert.equal(await openSimulatorTarget(fake, "xcode"), true);
  assert.equal(await openSimulatorTarget(fake, "app-store"), true);
  assert.equal(
    await openSimulatorTarget(fake, "download-android-studio"),
    true,
  );
  assert.equal(await openSimulatorTarget(fake, "android-studio"), false);
  assert.deepEqual(runner.lines("/usr/bin/open"), [
    "/usr/bin/open /Applications/Xcode.app",
    "/usr/bin/open macappstore://apps.apple.com/app/xcode/id497799835",
  ]);
  assert.deepEqual(fake.opened, ["https://developer.android.com/studio"]);
});
