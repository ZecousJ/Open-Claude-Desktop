/**
 * Balance only: Go answers `key.get` for an account without a plan group with a
 * registration that carries no key (webhost/backends.go webKeyFrom). The runner
 * reads it and opens the account with no models instead of failing the sign-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseWebKey } from "../../runner/src/web-remote-host";

const deviceId = "6f1c7d2a-4b8e-4c3f-9a1d-2e5b7c9d0f13";

test("a web key answer without a plan group parses with no key", () => {
  const key = parseWebKey({
    deviceId,
    registration: {
      device: {
        id: 0,
        device_name: "Claudex Web",
        platform: "web",
        arch: "",
        app_version: "",
        created_at: "2026-10-12T08:00:00Z",
        last_seen_at: null,
      },
      api_key: null,
      api_keys: [],
      created: false,
      moved: false,
      rotated: false,
      plan: null,
    },
  });
  assert.equal(key.deviceId, deviceId);
  assert.equal(key.registration.apiKey, null);
  assert.deepEqual(key.registration.apiKeys, []);
  assert.equal(key.registration.plan, null);
});
