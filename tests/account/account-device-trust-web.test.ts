import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceTrustStore } from "../../electron/remote-control/device-trust-store";
import { CoworkDevices } from "../../src-web/bridge/cowork-devices";
import { BrowserDeviceTrustClient } from "../../src-web/bridge/device-trust-client";

test("a computer lets another device read and tighten its device access, never loosen it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-trust-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new DeviceTrustStore(directory, "scope", "pc-1");
  assert.deepEqual(store.remote("deviceTrustSummary", []), {
    requireTrustedDevices: false,
    trusted: [],
    pending: [],
  });
  assert.throws(
    () => store.remote("deviceTrustRequire", [false]),
    /on the computer itself/,
  );
  assert.equal(
    store.remote("deviceTrustRequire", [true]).requireTrustedDevices,
    true,
  );
  assert.throws(
    () => store.remote("deviceTrustRevoke", ["missing"]),
    /no longer exists/,
  );
  assert.throws(() => store.remote("approveDeviceTrust", ["x"]), /Invalid/);
});

test("the web's Account merges every online computer's device access and sends only safe changes", async () => {
  const client = {
    id: "phone",
    name: "Pixel",
    platform: "Android",
    addedAt: "2026-10-20T00:00:00Z",
    fingerprint: "ab",
  };
  const states: Record<
    string,
    { requireTrustedDevices: boolean; trusted: unknown[] }
  > = {
    mac: { requireTrustedDevices: true, trusted: [client] },
    pc: { requireTrustedDevices: false, trusted: [] },
  };
  const calls: string[] = [];
  const transport = {
    json: async (url: string, init: RequestInit = {}) => {
      if (url.includes("/devices?"))
        return {
          data: [
            { id: "mac", name: "MacBook", online: true },
            { id: "pc", name: "Desktop", online: true },
            { id: "old", name: "Old", online: false },
          ],
        };
      const [, device, method] = /devices\/([^/]+)\/rpc\/(\w+)/.exec(url)!;
      const args = JSON.parse(String(init.body)).args;
      calls.push(`${device}:${method}:${JSON.stringify(args)}`);
      if (method === "deviceTrustRequire")
        states[device].requireTrustedDevices = true;
      if (method === "deviceTrustRevoke") states[device].trusted = [];
      return { data: { ...states[device], pending: [] } };
    },
  };
  const devices = new CoworkDevices(transport as never, () => {});
  const first = await devices.trustState();
  assert.equal(first.requireTrustedDevices, false);
  assert.deepEqual(
    first.trusted.map((row) => [row.id, row.name]),
    [["mac:phone", "Pixel · MacBook"]],
  );
  await assert.rejects(devices.setTrustRequired(false), /each computer/);
  assert.equal(
    (await devices.setTrustRequired(true)).requireTrustedDevices,
    true,
  );
  assert.equal((await devices.revokeTrusted("mac:phone")).trusted.length, 0);
  assert.ok(calls.includes('mac:deviceTrustRevoke:["phone"]'));
  assert.ok(!calls.some((call) => call.startsWith("old:")));
});

test("a device request waiting on its key cannot resume after A to B to A", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  let opened!: () => void;
  let release!: (key: CryptoKeyPair) => void;
  const openedKey = new Promise<void>((resolve) => { opened = resolve; });
  const heldKey = new Promise<CryptoKeyPair>((resolve) => { release = resolve; });
  let activation = { account: "A" };
  const calls: string[] = [];
  const trust = new BrowserDeviceTrustClient(() => activation.account, "test", async () => {
    opened();
    return heldKey;
  });
  const devices = new CoworkDevices({
    captureActivation() {
      const opening = activation;
      return () => {
        if (activation !== opening) throw new DOMException("The active account changed.", "AbortError");
      };
    },
    async json(path) {
      calls.push(path);
      return {};
    },
  }, () => {}, trust);
  const pending = devices.revokeTrusted("pc:phone");
  const refused = assert.rejects(pending, { name: "AbortError" });
  await openedKey;
  activation = { account: "B" };
  devices.clear();
  activation = { account: "A" };
  devices.clear();
  release(pair);
  await refused;
  assert.deepEqual(calls, []);
});
