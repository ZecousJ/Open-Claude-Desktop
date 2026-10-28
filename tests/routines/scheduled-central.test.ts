import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  AccountDeviceStateCache,
  registerDeviceTrustHandlers,
} from "../../electron/remote-control/account-device-state";
import {
  deviceMethods,
  deviceTrustBridgeMethods,
  deviceTrustMessage,
  trustedDeviceCall,
} from "../../shared/remote-devices";
import { desktopMethods } from "../../shared/desktop-bridge";
import { webMethodTable } from "../../shared/web-bridge-methods";

test("59: only a definite legacy handshake refusal uses the old authenticated device call", async () => {
  const calls: string[] = [];
  const signer = {
    publicKey: "unused on legacy host",
    name: "Client",
    platform: "macOS",
    sign: async () => {
      throw Error("Legacy calls do not sign envelopes");
    },
  };
  const result = await trustedDeviceCall(
    async (method, args) => {
      calls.push(method);
      if (method === "deviceTrustChallenge")
        throw Object.assign(Error("Not available on the web."), {
          code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
        });
      assert.deepEqual(args, []);
      return ["owned-directory"];
    },
    signer,
    "legacy-host",
    "listDirectories",
    [],
  );
  assert.deepEqual(result, ["owned-directory"]);
  assert.deepEqual(calls, ["deviceTrustChallenge", "listDirectories"]);
  for (const error of [Error("offline"), Error("Sign in to Claudex again.")]) {
    let count = 0;
    await assert.rejects(
      trustedDeviceCall(
        async () => {
          count++;
          throw error;
        },
        signer,
        "host",
        "listDirectories",
        [],
      ),
      (failure) => failure === error,
    );
    assert.equal(count, 1);
  }
  let count = 0;
  await assert.rejects(
    trustedDeviceCall(
      async () => {
        count++;
        return {};
      },
      signer,
      "host",
      "listDirectories",
      [],
    ),
    /Invalid device verification challenge/,
  );
  assert.equal(count, 1);
});

test("59: a handshake-refusal downgrade cannot bypass a protected host's actual authority", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b31-legacy-protection-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = new AccountDeviceStateCache(
    () => root,
    () => {},
  ).current({
    profileRoot: root,
    accountScope: "owner",
    identity: { id: "host", name: "Host", platform: "darwin", version: "1" },
  })!;
  state.trust.setRequired(true);
  const signer = {
    publicKey: "unused",
    name: "Client",
    platform: "macOS",
    sign: async () => "unused",
  };
  let calls = 0;
  await assert.rejects(
    trustedDeviceCall(
      async (method, args) => {
        calls++;
        if (method === "deviceTrustChallenge")
          throw Error("Device verification is unavailable.");
        return state.trust.authorize(method, args);
      },
      signer,
      "host",
      "listDirectories",
      [],
    ),
    /Verify this device/,
  );
  assert.equal(calls, 2);
  assert.equal(state.trust.state().requireTrustedDevices, true);
});

test("58/59: active owner cache keeps true registration dates, persists policy and retires identical owner objects on logout", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b31-account-device-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 100000;
  const cache = new AccountDeviceStateCache(
    () => root,
    () => {},
    () => now,
  );
  const owner = {
    profileRoot: path.join(root, "profile-a"),
    accountScope: "https://service.test:1",
    identity: {
      id: "host-device",
      name: "Actual Mac",
      platform: "darwin",
      version: "1",
    },
  };
  const first = cache.current(owner)!;
  first.trust.setRequired(true);
  const date = first.registration.snapshot(true, true).addedAt;
  now += 60000;
  assert.equal(cache.current({ ...owner }), first);
  assert.equal(first.registration.snapshot(true, true).lastSeenAt, date);
  first.registration.observed(false);
  assert.equal(
    first.registration.snapshot(true, true).lastSeenAt,
    new Date(now).toISOString(),
  );
  cache.current(undefined);
  const next = cache.current(owner)!;
  assert.notEqual(next, first);
  assert.equal(next.registration.snapshot(true, true).addedAt, date);
  assert.equal(next.trust.state().requireTrustedDevices, true);
  const other = cache.current({
    ...owner,
    accountScope: "https://other.test:1",
  })!;
  assert.equal(other.trust.state().requireTrustedDevices, false);
  const renamed = cache.current({
    ...owner,
    identity: { ...owner.identity, name: "Renamed Mac" },
  })!;
  assert.equal(renamed.registration.snapshot(true, true).name, "Renamed Mac");
  assert.equal(renamed.registration.snapshot(true, true).addedAt, date);
});

test("59: actual local handler registration approves the possession-proven pending fingerprint, rejects forged approvals and persists revocation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b31-trust-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = new AccountDeviceStateCache(
    () => root,
    () => {},
  );
  let active = cache.current({
    profileRoot: root,
    accountScope: "service:owner",
    identity: {
      id: "host-device",
      name: "Host",
      platform: "linux",
      version: "1",
    },
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerDeviceTrustHandlers(
    (name, handler) => handlers.set(name, handler),
    () => active,
  );
  assert.equal(
    handlers.get("setRequireTrustedDevices")!(true).requireTrustedDevices,
    true,
  );
  assert.throws(() => handlers.get("setRequireTrustedDevices")!("false"));
  const pair = generateKeyPairSync("ed25519");
  const challenge = active!.trust.challenge({
    publicKey: pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    name: "Browser",
    platform: "macOS",
  });
  const args: unknown[] = [];
  const signature = sign(
    null,
    Buffer.from(deviceTrustMessage(challenge, "deviceTrustEnroll", args)),
    pair.privateKey,
  ).toString("base64");
  active!.trust.enroll({
    deviceTrust: { challengeId: challenge.id, signature },
    args,
  });
  const pending = handlers.get("deviceTrustState")!().pending[0];
  assert.throws(
    () => handlers.get("approveDeviceTrust")!(pending.id, "wrong fingerprint"),
    /expired/,
  );
  assert.equal(
    handlers.get("approveDeviceTrust")!(pending.id, pending.fingerprint).trusted
      .length,
    1,
  );
  assert.equal(
    handlers.get("revokeDeviceTrust")!(pending.id).trusted.length,
    0,
  );
  active = undefined;
  cache.current(undefined);
  assert.throws(() => handlers.get("deviceTrustState")!(), /Sign in/);
});

test("59: the trust authority stays on the computer; the web only reads and tightens it through the verified relay", () => {
  for (const name of deviceTrustBridgeMethods) {
    assert.ok(desktopMethods.includes(name));
    // Settings → Account on the web goes through each computer's relay.
    assert.equal(webMethodTable.get(name), "browser");
    assert.equal((deviceMethods as readonly string[]).includes(name), false);
  }
  // The relay offers reading, turning the requirement on and removing a
  // device; approving and turning it off are not relay methods.
  assert.deepEqual(
    (deviceMethods as readonly string[]).filter((name) =>
      /^deviceTrust(Summary|Require|Revoke)$/.test(name),
    ),
    ["deviceTrustSummary", "deviceTrustRequire", "deviceTrustRevoke"],
  );
  for (const name of [
    "beginRoutineMigration",
    "restoreRoutineMigration",
    "routineMigration",
    "migrateRoutine",
  ] as const)
    assert.equal(webMethodTable.get(name), "absent");
  for (const name of [
    "routineWorkspace",
    "importRoutineMigration",
    "deleteRoutineMigration",
    "listTaskFolderDirectory",
    "coworkFolderAccess",
    "grantCoworkFolder",
  ] as const)
    assert.equal(webMethodTable.get(name), "remote-runner");
});
