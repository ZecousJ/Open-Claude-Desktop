import test from "node:test";
import assert from "node:assert/strict";
import { OfficialWindowCreationCancelled } from "../electron/official-ui/staged-window";
import { runInertStartup } from "./support/startup-staging-fixture";
test("actual cold startup cancellation keeps existing main and completes started without quitting", async () => {
  const winner = { isDestroyed: () => false };
  const { started, window, quits, dialogs } = await runInertStartup(
    async () => {
      throw new OfficialWindowCreationCancelled();
    },
    winner,
  );
  assert.equal(started, true);
  assert.equal(window, winner);
  assert.equal(quits, 0);
  assert.deepEqual(dialogs, []);
});
test("actual cold startup cancellation with no committed main still enables existing recovery entrypoints", async () => {
  const { started, window, quits, dialogs } = await runInertStartup(
    async () => {
      throw new OfficialWindowCreationCancelled();
    },
    undefined,
  );
  assert.equal(started, true);
  assert.equal(window, undefined);
  assert.equal(quits, 0);
  assert.deepEqual(dialogs, []);
});
test("actual current cold startup load failure retains original failure/quit policy with fixed sanitized message", async () => {
  const { started, quits, dialogs } = await runInertStartup(async () => {
    throw Error("https://fixture.invalid/private?token=secret");
  }, undefined);
  assert.equal(started, false);
  assert.equal(quits, 1);
  assert.equal(dialogs.length, 1);
  assert.equal(
    dialogs[0][1],
    "The interface could not be loaded. Please try again.",
  );
  assert.equal(JSON.stringify(dialogs).includes("secret"), false);
});

test("actual cold startup old-activation cleanup error reports fixed unconfirmed diagnostic without quitting", async (t) => {
  const { retireInertStartup } =
    await import("./support/startup-staging-fixture");
  const log = t.mock.method(console, "error", () => {});
  const result = await runInertStartup(async () => {
    retireInertStartup();
    throw Error("destroy private-query failed");
  }, undefined);
  assert.equal(result.started, true);
  assert.equal(result.quits, 0);
  assert.deepEqual(result.dialogs, []);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [["Retired official window cleanup was not confirmed."]],
  );
});
