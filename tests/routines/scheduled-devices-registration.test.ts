import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceRegistration } from "../../electron/remote-control/device-registration";
const identity = {
  id: "pc-registration",
  name: "Studio",
  platform: "darwin",
  version: "1",
};

test("registration survives restarts; reads do not invent last seen and accounts are isolated", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b31-registration-"),
  );
  try {
    let now = Date.parse("2026-10-19T00:00:00Z");
    const first = new DeviceRegistration(
      directory,
      "service:account-a",
      identity,
      () => now,
    );
    const original = first.snapshot(true, false);
    now += 60_000;
    assert.deepEqual(first.snapshot(true, false), original);
    first.observed(true);
    const observed = first.snapshot(true, true);
    assert.equal(observed.addedAt, original.addedAt);
    assert.equal(observed.lastSeenAt, new Date(now).toISOString());
    now += 60_000;
    assert.equal(
      new DeviceRegistration(
        directory,
        "service:account-a",
        identity,
        () => now,
      ).snapshot(false, false).lastSeenAt,
      observed.lastSeenAt,
    );
    assert.equal(
      new DeviceRegistration(
        directory,
        "service:account-b",
        identity,
        () => now,
      ).snapshot(false, false).addedAt,
      new Date(now).toISOString(),
    );
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, "invalid");
    assert.throws(
      () => new DeviceRegistration(directory, "service:account-a", identity),
      /JSON/,
    );
    assert.equal(
      fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a renewed link id starts a new registration instead of failing", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b31-registration-"),
  );
  try {
    new DeviceRegistration(directory, "service:account-a", identity);
    const renewed = new DeviceRegistration(directory, "service:account-a", {
      ...identity,
      id: "pc-renewed",
    });
    assert.equal(renewed.snapshot(true, false).id, "pc-renewed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
