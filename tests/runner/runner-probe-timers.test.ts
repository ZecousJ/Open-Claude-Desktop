import assert from "node:assert/strict";
import test from "node:test";
import { useElectronShim } from "./runner-core-support.test.ts";

useElectronShim();
const { probeRegisteredNames } = await import("../../runner/src/dispatcher");

test("probing the handler names starts no timers against the inert context", async () => {
  let fired = 0;
  const names = probeRegisteredNames((handle) => {
    handle("diagnosticsState", () => {});
    setInterval(() => fired++, 1);
    setTimeout(() => fired++, 1);
  });
  assert.deepEqual(names, ["diagnosticsState"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fired, 0);
});
