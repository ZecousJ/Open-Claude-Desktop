import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  AppUpdater,
  checkIntervalMs,
  firstCheckDelayMs,
  stagedPeekIntervalMs,
  type UpdaterOptions,
} from "../../electron/updates/updater";
import { EarlyUpdateInstall } from "../../electron/updates/early-install";
import { NativeAppUpdater } from "../../electron/updates/native";
import { writeStaged } from "../../electron/updates/staging";
import {
  parseUpdatePolicy,
  updaterIntervals,
} from "../../shared/update-policy";
import { parseRelease } from "../../shared/claudex-contract";

function setup(context: TestContext, overrides: Partial<UpdaterOptions> = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cadence-"));
  context.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const timers: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  let checks = 0;
  const updater = new AppUpdater({
    userData,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    fetchRelease: async () => {
      checks++;
      return { latestVersion: "1.0.0", downloadUrl: null, sha256: null };
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    ...overrides,
  });
  context.after(() => updater.stop());
  return { updater, timers, checks: () => checks };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("official cadence waits 90 seconds, then checks every four hours", async (context) => {
  const run = setup(context);
  assert.equal(firstCheckDelayMs, 90_000);
  assert.equal(checkIntervalMs, 4 * 60 * 60_000);
  assert.equal(stagedPeekIntervalMs, 120 * 60_000);
  run.updater.start();
  assert.equal(run.checks(), 0);
  assert.equal(run.timers.at(-1)?.ms, firstCheckDelayMs);
  run.timers.at(-1)!.callback();
  await settle();
  assert.equal(run.checks(), 1);
  assert.equal(run.timers.at(-1)?.ms, checkIntervalMs);
  run.updater.stop();
  assert.equal(run.timers.at(-1)?.cancelled, true);
});

test("remote tuning accepts only 1–3 hourly ticks and caps staged peeks at 120 minutes", () => {
  for (const ticks of [1, 2, 3])
    assert.equal(
      updaterIntervals({ check_interval_ticks: ticks }).check,
      ticks * 60 * 60_000,
    );
  for (const ticks of [0, -1, 4, 1.5, Infinity, NaN])
    assert.equal(
      updaterIntervals({ check_interval_ticks: ticks }).check,
      checkIntervalMs,
    );
  assert.equal(
    updaterIntervals({ staged_peek_min_interval_minutes: 180 }).peek,
    stagedPeekIntervalMs,
  );
  assert.equal(
    updaterIntervals({ staged_peek_min_interval_minutes: 15 }).peek,
    15 * 60_000,
  );
  assert.equal(
    updaterIntervals({ staged_peek_min_interval_minutes: 0 }).peek,
    stagedPeekIntervalMs,
  );
});

test("release responses carry validated remote tuning into the next scheduled check", async (context) => {
  const parsed = parseRelease({
    api_version: 1,
    state: "current",
    desktop_updater_config: { check_interval_ticks: 2 },
  });
  assert.equal(parsed.desktopUpdaterConfig?.check_interval_ticks, 2);
  const run = setup(context, { fetchRelease: async () => parsed });
  run.updater.start();
  run.timers.at(-1)!.callback();
  await settle();
  assert.equal(run.timers.at(-1)?.ms, 2 * 60 * 60_000);
});

test("staged updates peek without a full check or losing the ready state", async (context) => {
  let peeks = 0;
  const run = setup(context, {
    peekRelease: async () => {
      peeks++;
      return { latestVersion: "1.1.0", downloadUrl: null, sha256: null };
    },
  });
  const file = path.join(run.updater.dir, "Claudex.zip");
  fs.mkdirSync(run.updater.dir, { recursive: true });
  fs.writeFileSync(file, "staged");
  writeStaged(run.updater.dir, {
    version: "1.1.0",
    kind: "mac-zip",
    file,
    sha256: "a".repeat(64),
    stagedAt: 0,
    attempts: 0,
  });
  run.updater.start();
  run.timers.at(-1)!.callback();
  await settle();
  assert.equal(peeks, 1);
  assert.equal(run.checks(), 0);
  assert.equal(run.updater.status().phase, "ready");
  assert.equal(run.timers.at(-1)?.ms, stagedPeekIntervalMs);
  await run.updater.check({ manual: true });
  assert.equal(run.checks(), 1);
});

test("administrator update blocking hides the menu and silently skips manual/background checks", async (context) => {
  assert.equal(
    parseUpdatePolicy({ disableAutoUpdates: true }).disableAutoUpdates,
    true,
  );
  assert.equal(
    parseUpdatePolicy({ disableAutoUpdates: "true" }).disableAutoUpdates,
    undefined,
  );
  const run = setup(context, { disableAutoUpdates: true });
  assert.equal(run.updater.menuVisible(), false);
  assert.equal(run.updater.supported(), false);
  assert.equal(
    (await run.updater.check({ manual: true })).status.phase,
    "idle",
  );
  run.updater.start();
  await run.updater.check();
  assert.equal(run.timers.length, 0);
  assert.equal(run.checks(), 0);
});

test("a newer staged peek downloads and verifies the replacement, then notifies the install hook", async (context) => {
  const content = "verified replacement";
  const checksum = createHash("sha256").update(content).digest("hex");
  let downloads = 0;
  let installed = 0;
  const run = setup(context, {
    peekRelease: async () => ({
      latestVersion: "1.2.0",
      downloadUrl: "https://updates.example.com/Claudex-1.2.0.zip",
      sha256: checksum,
    }),
    download: async ({ file }) => {
      downloads++;
      fs.writeFileSync(file, content);
    },
    onDownloaded: () => {
      installed++;
    },
  });
  const file = path.join(run.updater.dir, "old.zip");
  fs.mkdirSync(run.updater.dir, { recursive: true });
  fs.writeFileSync(file, "old");
  writeStaged(run.updater.dir, {
    version: "1.1.0",
    kind: "mac-zip",
    file,
    sha256: "a".repeat(64),
    stagedAt: 0,
    attempts: 0,
  });
  await run.updater.check();
  assert.equal(run.checks(), 0);
  assert.equal(downloads, 1);
  assert.equal(installed, 1);
  assert.equal(run.updater.staged()?.version, "1.2.0");
  assert.equal(run.updater.status().phase, "ready");
});

test("native staged checks only ask the native updater when the peek finds a newer version", async (context) => {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-native-cadence-"),
  );
  context.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  let checks = 0;
  let latest: string | null = "1.1.0";
  const driver = Object.assign(new EventEmitter(), {
    setFeedURL: () => {},
    checkForUpdates: () => {
      checks++;
    },
    quitAndInstall: () => {},
  });
  const updater = new NativeAppUpdater({
    driver,
    userData,
    currentVersion: "1.0.0",
    feedUrl: "https://updates.example.com",
    onStatus: () => {},
    log: () => {},
    peekVersion: async () => latest,
  });
  context.after(() => updater.stop());
  driver.emit("update-downloaded", {}, "notes", "1.1.0");
  await updater.check();
  assert.equal(checks, 0);
  latest = null;
  await updater.check();
  assert.equal(checks, 0);
  latest = "1.2.0";
  const check = updater.check();
  await settle();
  assert.equal(checks, 1);
  driver.emit("update-downloaded", {}, "notes", "1.2.0");
  await check;
  assert.equal(updater.staged()?.version, "1.2.0");
});

test("early installation only follows a new download before the first main window and waits for work", () => {
  const installs: string[] = [];
  const early = new EarlyUpdateInstall(() => installs.push("install"));
  const idle = { mainWindow: false, busy: false, ready: true, enabled: true };
  early.update(idle);
  assert.deepEqual(installs, []);
  early.onDownloaded();
  early.update({ ...idle, busy: true });
  early.update({ ...idle, enabled: false });
  assert.deepEqual(installs, []);
  early.update(idle);
  early.update(idle);
  assert.deepEqual(installs, ["install"]);
  const opened = new EarlyUpdateInstall(() =>
    assert.fail("never after a window has opened"),
  );
  opened.update({ ...idle, mainWindow: true });
  opened.onDownloaded();
  opened.update(idle);
});
