import test from "node:test";
import assert from "node:assert/strict";
import { useElectronShim } from "./runner-core-support.test.ts";

useElectronShim();
const { runnerHost } = await import("../../runner/src/main");
const { parseNetConfig } = await import("../../runner/src/net-policy-compile");

test("Cowork-only runners advertise their supported cloud permission modes", () => {
  const network = parseNetConfig({}, "namespaces", []).policy;
  const cowork = runnerHost({ modes: ["cowork"], network });
  const code = runnerHost({ modes: ["code"], network });
  assert.equal(cowork.capabilities.cloudCowork, true);
  assert.equal(cowork.capabilities.cloudCode, false);
  assert.deepEqual(cowork.cloud, code.cloud);
  assert.ok(cowork.cloud?.permissionModes.includes("auto"));
  assert.ok(cowork.cloud?.permissionModes.includes("bypass"));
  assert.equal(runnerHost({ modes: ["chat"], network }).cloud, undefined);
});
