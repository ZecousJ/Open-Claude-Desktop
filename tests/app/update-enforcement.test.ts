import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import {
  parseUpdatePolicy,
  updateDeviceQuery,
} from "../../shared/update-policy";
import {
  UpdateLifecycle,
  type UpdateActivity,
} from "../../electron/updates/lifecycle";
import { beginUpdateSession } from "../../electron/updates/session";
import {
  NativeAppUpdater,
  squirrelFeedUrl,
  squirrelWindowsExecutable,
} from "../../electron/updates/native";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import {
  macApplyScript,
  windowsApplyScript,
} from "../../electron/updates/scripts";
import {
  clearShipItStage,
  shipItDirectory,
  shipItStderr,
} from "../../electron/updates/shipit";
import { AppUpdater } from "../../electron/updates/updater";

const minute = 60_000;
const hour = 60 * minute;
const idle: UpdateActivity = {
  enabled: true,
  version: "1.1.0",
  failed: false,
  busy: false,
  focused: false,
  fullScreen: false,
  idleSeconds: 600,
  checking: false,
  windowReady: true,
  quitting: false,
};

function flow(crash = true, value?: unknown) {
  const installs: string[] = [];
  const logs: string[] = [];
  return {
    installs,
    logs,
    lifecycle: new UpdateLifecycle(
      parseUpdatePolicy(value),
      crash,
      0,
      (reason) => installs.push(reason),
      (message) => logs.push(message),
    ),
  };
}

test("unclean launch waits for work and focused user activity, then installs without a prompt", () => {
  const run = flow();
  run.lifecycle.update({ ...idle, busy: true }, 0);
  run.lifecycle.update(
    { ...idle, focused: true, idleSeconds: 599 },
    40 * minute,
  );
  assert.deepEqual(run.installs, []);
  run.lifecycle.update({ ...idle, focused: true }, 41 * minute);
  run.lifecycle.update(idle, 42 * minute);
  assert.deepEqual(run.installs, ["unclean-exit"]);
});

test("crash install observes the 30-minute default, 120-minute cap, and strict window edge", () => {
  for (const minutes of [30, 120]) {
    for (const atEdge of [false, true]) {
      const run = flow(
        true,
        minutes === 120 ? { uncleanExitInstallWindowMinutes: 999 } : undefined,
      );
      run.lifecycle.update(idle, minutes * minute - (atEdge ? 0 : 1));
      assert.equal(run.installs.length, atEdge ? 0 : 1);
    }
  }
  for (const value of [0, -1, "30", null, Infinity]) {
    const run = flow(true, { uncleanExitInstallWindowMinutes: value });
    run.lifecycle.update(idle, 0);
    assert.deepEqual(run.installs, []);
  }
});

test("crash install blockers and withdrawal cannot revive an expired window", () => {
  for (const blocker of [
    { failed: true },
    { fullScreen: true },
    { checking: true },
    { windowReady: false },
    { quitting: true },
    { enabled: false },
  ]) {
    const run = flow();
    run.lifecycle.update({ ...idle, ...blocker }, minute);
    assert.equal(run.installs.length, 0);
  }
  const run = flow();
  run.lifecycle.update({ ...idle, busy: true }, minute);
  run.lifecycle.update({ ...idle, version: undefined }, 31 * minute);
  run.lifecycle.update(idle, 32 * minute);
  assert.deepEqual(run.installs, []);
});

test("a clean launch never takes the crash shortcut", () => {
  const run = flow(false);
  run.lifecycle.update(idle, 0);
  assert.deepEqual(run.installs, []);
});

test("default 72 counted hours requires ten minutes system idle and defers/logs active work", () => {
  const run = flow(false);
  run.lifecycle.update(idle, 0);
  run.lifecycle.update(idle, 70 * hour);
  run.lifecycle.update({ ...idle, idleSeconds: 599 }, 71 * hour);
  run.lifecycle.update({ ...idle, busy: true }, 72 * hour);
  assert.deepEqual(run.installs, []);
  assert.match(run.logs[0], /Claudex is working/);
  run.lifecycle.update(idle, 73 * hour);
  assert.deepEqual(run.installs, ["enforcement"]);
});

test("an explicit enforcement window ignores user activity but never interrupts Claudex work", () => {
  const run = flow(false, { enforcementHours: 1 });
  const active = { ...idle, idleSeconds: 0, focused: true, fullScreen: true };
  run.lifecycle.update(active, 0);
  assert.deepEqual(run.installs, []);
  run.lifecycle.update({ ...active, busy: true }, 10 * minute);
  assert.deepEqual(run.installs, []);
  run.lifecycle.update(active, 11 * minute);
  assert.deepEqual(run.installs, ["enforcement"]);
  for (const enforcementHours of [0, 73, 1.5, "1", NaN])
    assert.equal(
      parseUpdatePolicy({ enforcementHours }).enforcementHours,
      undefined,
    );
});

test("the sentinel detects a crashed run, clears clean exits, and preserves a live owner", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = beginUpdateSession(dir, 10, 100, () => false);
  assert.equal(first.previousExitUnclean, false);
  const live = beginUpdateSession(dir, 11, 100, () => true);
  live.clean();
  const next = beginUpdateSession(dir, 12, 100, () => false);
  assert.equal(next.previousExitUnclean, true);
  first.clean();
  next.clean();
  assert.equal(
    beginUpdateSession(dir, 13, 100, () => false).previousExitUnclean,
    false,
  );
});

test("the feed carries the official device, version, OS, cap and channel query names", async () => {
  const device = {
    deviceId: "my device",
    version: "1.0.0",
    osVersion: "15.4.1",
    maxVersion: "2.0.0",
    channelUuid: "channel&1",
  };
  const query = updateDeviceQuery(device);
  assert.equal(query.get("device_id"), device.deviceId);
  assert.equal(query.get("version"), device.version);
  assert.equal(query.get("os_version"), device.osVersion);
  assert.equal(query.get("maxVersion"), device.maxVersion);
  assert.equal(query.get("channelUuid"), device.channelUuid);
  const feed = new URL(
    squirrelFeedUrl(
      "https://updates.example.com/api/desktop/darwin/arm64/squirrel/update?existing=1",
      device,
    ),
  );
  assert.equal(feed.searchParams.get("existing"), "1");
  assert.equal(feed.searchParams.get("channelUuid"), device.channelUuid);
  for (const bad of ["http://example.com", "https://user:pass@example.com"])
    assert.throws(() => squirrelFeedUrl(bad, device));
  assert.equal(
    squirrelWindowsExecutable("C:\\Claudex\\app-1.0.0\\Claudex.exe"),
    "C:\\Claudex\\Update.exe",
  );
  let requested = "";
  const client = new Sub2ApiClient(
    "https://updates.example.com",
    async (input) => {
      requested = String(input);
      return new Response(
        JSON.stringify({ code: 0, data: { api_version: 1, state: "unknown" } }),
      );
    },
  );
  await client.claudexRelease("deb", device);
  assert.equal(new URL(requested).searchParams.get("package"), "deb");
  assert.equal(
    new URL(requested).searchParams.get("device_id"),
    device.deviceId,
  );
});

test("native Squirrel checks, publishes readiness, joins manual checks and calls quitAndInstall", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-native-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driver = Object.assign(new EventEmitter(), {
    setFeedURL: (options: unknown) => {
      assert.deepEqual(options, {
        url: "https://updates.example.com",
        serverType: "json",
      });
    },
    checkForUpdates: () => {
      driver.emit("checking-for-update");
    },
    quitAndInstall: () => {
      installed++;
    },
  });
  let installed = 0;
  const create = () =>
    new NativeAppUpdater({
      driver,
      feedUrl: "https://updates.example.com",
      currentVersion: "1.0.0",
      userData: dir,
      onStatus: () => {},
      log: () => {},
    });
  const updater = create();
  t.after(() => updater.stop());
  const check = updater.check();
  assert.equal(updater.check({ manual: true }), check);
  assert.equal(updater.status().manual, true);
  driver.emit("update-available");
  assert.equal(updater.status().phase, "downloading");
  driver.emit("update-downloaded", {}, "notes", "Claudex 1.1.0");
  assert.equal((await check).status.phase, "ready");
  updater.quitAndInstall();
  assert.equal(installed, 1);
  const retry = create();
  t.after(() => retry.stop());
  driver.emit("update-downloaded", {}, "notes", "Claudex 1.1.0");
  assert.equal(retry.staged()?.attempts, 1);
  assert.equal(retry.status().retry, true);
});

test("install helpers capture stderr and verify a signed Mac app before replacing it", () => {
  assert.match(macApplyScript, /exec 2>>"\$RESULT.stderr.log"/);
  assert.match(macApplyScript, /codesign --verify --deep --strict "\$NEW"/);
  assert.match(macApplyScript, /certificate leaf\[subject.OU\]/);
  assert.match(windowsApplyScript, /RedirectStandardError/);
});

test("an ad-hoc signed Mac install is not held to a signature it cannot have", () => {
  // Both checks sit inside the Team ID branch: an ad-hoc, linker-signed install
  // (no Team ID) skips them, as every build so far is.
  const branch = macApplyScript.match(
    /\nif \[ -n "\$TEAM" \] && \[ "\$TEAM" != "not set" \]; then\n([^]*?)\nfi\n/,
  );
  assert.ok(branch, "the Team ID branch is there");
  assert.match(branch[1], /codesign --verify --deep --strict "\$NEW"/);
  assert.match(branch[1], /certificate leaf\[subject.OU\]/);
  const outside = macApplyScript.replace(branch[0], "\n");
  assert.doesNotMatch(outside, /codesign --verify/);
});

test("ShipIt rollback removes only its own stage, rejects directory symlinks and bounds stderr", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-shipit-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = shipItDirectory(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ShipItState.plist"), "state");
  fs.mkdirSync(path.join(dir, "update.1"));
  fs.writeFileSync(path.join(dir, "ShipIt_stderr.log"), "x".repeat(20_000));
  assert.equal(shipItStderr(home)?.length, 16_384);
  let removed = false;
  clearShipItStage(home, () => {
    removed = true;
  });
  assert.equal(removed, true);
  assert.deepEqual(fs.readdirSync(dir), ["ShipIt_stderr.log"]);
  fs.rmSync(dir, { recursive: true });
  const elsewhere = path.join(home, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, dir);
  assert.throws(
    () => clearShipItStage(home, () => assert.fail("must not remove job")),
    /Unsafe/,
  );
});

test("the package updater rejects releases above the configured maximum without downloading", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cap-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const updater = new AppUpdater({
    userData,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    maxVersion: "1.1.0",
    fetchRelease: async () => ({
      latestVersion: "2.0.0",
      downloadUrl: "https://example.com/update.zip",
      sha256: "a".repeat(64),
    }),
    download: async () => assert.fail("must not download above cap"),
  });
  assert.equal((await updater.check()).status.phase, "up-to-date");
});
