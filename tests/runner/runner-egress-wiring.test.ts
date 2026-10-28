// W-EGRESS: the runner's network configuration (runner/src/main.ts wiring).
import assert from "node:assert/strict";
import test from "node:test";
import { useElectronShim } from "./runner-core-support.test.ts";

useElectronShim();
const { parseConfig } = await import("../../runner/src/runner-config");

const env = (extra: Record<string, string> = {}) => ({
  CLAUDEX_RUNNER_SERVICE_URL: "https://claudex.example.com",
  CLAUDEX_RUNNER_PUBLIC_URL: "https://www.claudex.example.com",
  CLAUDEX_RUNNER_TOKEN: "runner-token-0123456789",
  CLAUDEX_RUNNER_CODEX: "/opt/codex/vendor/x/codex/codex",
  ...extra,
});

test("sandboxes default to trusted and never reach the service by name", () => {
  const config = parseConfig(env(), "/opt/claudex-runner");
  assert.equal(config.network.level, "trusted");
  assert.deepEqual(config.networkWarnings, []);
  assert.deepEqual(config.network.deniedHosts, [
    "claudex.example.com",
    "www.claudex.example.com",
  ]);
  assert.equal(config.egressSocket, undefined);
});

test("bwrap caps the level at trusted; settings are validated at start", () => {
  const config = parseConfig(
    env({
      CLAUDEX_RUNNER_NETWORK: "full",
      CLAUDEX_RUNNER_EGRESS_DENY: "203.0.113.10/32",
    }),
  );
  assert.equal(config.network.level, "trusted");
  assert.match(config.networkWarnings[0]!, /using trusted/);
  assert.deepEqual(config.network.deniedAddresses, ["203.0.113.10/32"]);
  assert.equal(
    parseConfig(env({ CLAUDEX_RUNNER_NETWORK: "none" })).network.level,
    "none",
  );
  assert.throws(
    () => parseConfig(env({ CLAUDEX_RUNNER_NETWORK: "everything" })),
    /CLAUDEX_RUNNER_NETWORK must be none, trusted, custom or full/,
  );
  assert.throws(() =>
    parseConfig(env({ CLAUDEX_RUNNER_TRUSTED_DOMAINS: "*" })),
  );
});

test("an external proxy socket is still accepted", () => {
  const config = parseConfig(
    env({ CLAUDEX_RUNNER_EGRESS_SOCKET: "/run/claudex-egress/all.sock" }),
  );
  assert.equal(config.egressSocket, "/run/claudex-egress/all.sock");
});
