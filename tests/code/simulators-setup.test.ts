import test from "node:test";
import assert from "node:assert/strict";
import {
  androidSdkRoots,
  androidStudioLocations,
  checkAndroidSetup,
  checkIosSetup,
  findAndroidTools,
  findIdb,
  type Environment,
} from "../../electron/simulators/toolchain";
import { CommandError } from "../../electron/simulators/runner";
import {
  androidSetupReady,
  iosSetupReady,
  simulatorSupported,
} from "../../shared/simulators";
import { FakeRunner, fakeProbe, iosList } from "../support/simulators-fakes";

const mac: Environment = {
  platform: "darwin",
  env: { PATH: "/usr/bin:/bin" },
  home: "/Users/me",
  arch: "arm64",
};
const windows: Environment = {
  platform: "win32",
  env: {
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    Path: "C:\\Windows",
  },
  home: "C:\\Users\\me",
  arch: "x64",
};

test("which kinds a platform can run", () => {
  assert.equal(simulatorSupported("ios", "darwin"), true);
  assert.equal(simulatorSupported("ios", "win32"), false);
  assert.equal(simulatorSupported("android", "darwin"), true);
  assert.equal(simulatorSupported("android", "win32"), true);
  assert.equal(simulatorSupported("android", "linux"), false);
});

test("Android SDK roots: the variables first, then the default folder", () => {
  assert.deepEqual(
    androidSdkRoots({
      ...mac,
      env: { ANDROID_HOME: "/opt/sdk", ANDROID_SDK_ROOT: "" },
    }),
    ["/opt/sdk", "/Users/me/Library/Android/sdk"],
  );
  assert.match(androidSdkRoots(windows)[0], /Android[\\/]Sdk$/);
});

test("Android Studio's places", () => {
  assert.deepEqual(
    androidStudioLocations(mac).map((place) => place.marker),
    [
      "/Applications/Android Studio.app",
      "/Users/me/Applications/Android Studio.app",
    ],
  );
  assert.deepEqual(androidStudioLocations(mac)[0].launch, [
    "/usr/bin/open",
    "-a",
    "Android Studio",
  ]);
  assert.ok(androidStudioLocations(windows)[0].marker.endsWith("studio64.exe"));
  assert.deepEqual(androidStudioLocations({ ...mac, platform: "linux" }), []);
});

test("adb and the emulator are found in the SDK, else on the PATH", async () => {
  const sdk = "/Users/me/Library/Android/sdk";
  const probe = fakeProbe({
    [sdk]: [],
    [`${sdk}/platform-tools/adb`]: true,
    "/usr/bin/emulator": true,
  });
  const found = await findAndroidTools(mac, probe);
  assert.equal(found.adb, `${sdk}/platform-tools/adb`);
  assert.equal(found.emulator, "/usr/bin/emulator");
  assert.deepEqual(found.sdkRoots, [sdk]);
});

const sdk = "/Users/me/Library/Android/sdk";
const sdkFiles: Record<string, string | string[] | true> = {
  [`${sdk}/platform-tools/adb`]: true,
  [`${sdk}/emulator/emulator`]: true,
  [`${sdk}/system-images/android-35/google_apis/arm64-v8a/system.img`]: true,
  "/Applications/Android Studio.app": [],
};

test("Android setup: everything there", async () => {
  const status = await checkAndroidSetup({
    environment: mac,
    probe: fakeProbe({ ...sdkFiles }),
    runner: new FakeRunner(() => "INFO | x\nPixel_9\n"),
  });
  assert.deepEqual(status, {
    studioInstalled: true,
    platformTools: true,
    emulator: true,
    systemImage: true,
    avd: true,
    sdkRoot: sdk,
  });
  assert.equal(androidSetupReady(status), true);
});

test("Android setup: Studio installed, nothing else yet", async () => {
  const status = await checkAndroidSetup({
    environment: mac,
    probe: fakeProbe({ "/Applications/Android Studio.app": [] }),
    runner: new FakeRunner(() => ""),
  });
  assert.equal(status.studioInstalled, true);
  assert.equal(status.platformTools, false);
  assert.equal(status.emulator, false);
  assert.equal(status.systemImage, false);
  assert.equal(status.avd, false);
  assert.equal(androidSetupReady(status), false);
});

test("Android setup: no virtual device, and a system image for the other CPU does not count", async () => {
  const status = await checkAndroidSetup({
    environment: mac,
    probe: fakeProbe({
      [`${sdk}/platform-tools/adb`]: true,
      [`${sdk}/emulator/emulator`]: true,
      [`${sdk}/system-images/android-35/google_apis/x86_64/system.img`]: true,
    }),
    runner: new FakeRunner(() => "INFO | Storing crashdata\n"),
  });
  assert.equal(status.systemImage, false);
  assert.equal(status.avd, false);
});

test("Android setup: an emulator that fails to list leaves the virtual device unknown", async () => {
  const status = await checkAndroidSetup({
    environment: mac,
    probe: fakeProbe({ ...sdkFiles }),
    runner: new FakeRunner((file) => new CommandError("failed", file, 1, "")),
  });
  assert.equal(status.avd, undefined);
  assert.equal(androidSetupReady(status), false);
});

const developer = "/Applications/Xcode.app/Contents/Developer";
const xcodeFiles = {
  [`${developer}/Platforms/iPhoneSimulator.platform`]: [],
};

function xcodeRunner(selected: string | Error) {
  return new FakeRunner((file, args) => {
    if (file === "xcode-select") return selected;
    if (file === "xcodebuild") return "Xcode 27.0\nBuild version 27A1\n";
    if (args[1] === "list") return iosList;
    return "";
  });
}

test("iOS setup: Xcode selected, with simulators", async () => {
  const status = await checkIosSetup({
    environment: mac,
    probe: fakeProbe({ ...xcodeFiles, "/opt/homebrew/bin/idb": true }),
    runner: xcodeRunner(developer),
  });
  assert.deepEqual(status, {
    xcode: true,
    xcodeVersion: "27.0",
    simulators: true,
    input: true,
  });
  assert.equal(iosSetupReady(status), true);
});

test("iOS setup: only the command-line tools are selected", async () => {
  const status = await checkIosSetup({
    environment: mac,
    probe: fakeProbe({ ...xcodeFiles }),
    runner: xcodeRunner("/Library/Developer/CommandLineTools"),
  });
  assert.equal(status.xcodeSelectFixPath, developer);
  assert.equal(status.input, false);
  assert.equal(iosSetupReady(status), false);
});

test("iOS setup: Xcode somewhere else is installed but can't be named for the command", async () => {
  const status = await checkIosSetup({
    environment: mac,
    probe: fakeProbe({
      "/Applications/Xcode-beta.app/Contents/Developer/Platforms/iPhoneSimulator.platform":
        [],
    }),
    runner: xcodeRunner(new CommandError("failed", "xcode-select", 2, "")),
  });
  assert.equal(status.xcodeSelectFixPath, "");
});

test("iOS setup: no Xcode", async () => {
  const status = await checkIosSetup({
    environment: mac,
    probe: fakeProbe({}),
    runner: xcodeRunner(new CommandError("failed", "xcode-select", 2, "")),
  });
  assert.equal(status.xcode, false);
  assert.equal(status.simulators, false);
  assert.equal(status.xcodeSelectFixPath, undefined);
});

test("iOS setup: Xcode without an iOS runtime", async () => {
  const status = await checkIosSetup({
    environment: mac,
    probe: fakeProbe({ ...xcodeFiles }),
    runner: new FakeRunner((file, args) => {
      if (file === "xcode-select") return developer;
      if (args[1] === "list") return JSON.stringify({ devices: {} });
      return "Xcode 27.0";
    }),
  });
  assert.equal(status.xcode, true);
  assert.equal(status.simulators, false);
});

test("iOS setup is never ready off a Mac, and idb is only looked for on one", async () => {
  const status = await checkIosSetup({
    environment: windows,
    probe: fakeProbe({}),
    runner: xcodeRunner(developer),
  });
  assert.equal(iosSetupReady(status), false);
  assert.equal(
    await findIdb(windows, fakeProbe({ "/opt/homebrew/bin/idb": true })),
    undefined,
  );
  assert.equal(
    await findIdb(
      mac,
      fakeProbe({ "/Users/me/Library/Python/3.12/bin/idb": true }),
    ),
    "/Users/me/Library/Python/3.12/bin/idb",
  );
});
