import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import { AccountTab } from "../../src/settings/tabs/Account";
import { routineDom } from "../support/routine-dom";

test("offline Account has an explicit empty relay inventory", async () => {
  const bridge = createFixtureDesktop();
  assert.deepEqual(await bridge.listCoworkDevices(), []);
  assert.equal(await bridge.activeSessions(), null);
  assert.equal((await bridge.accountProfile()).kind, "local");
});

test("the real Account renderer loads the offline fixture without a spurious account error", async (t) => {
  const bridge = createFixtureDesktop();
  const e = await routineDom(bridge, { jsdom: true });
  // Use the same proxy as the real preview, including its fallback methods.
  e.window.desktop = bridge;
  t.after(e.clean);
  const errors: unknown[] = [];
  const snapshot = await bridge.snapshot();
  await e.render(
    createElement(AccountTab, {
      settings: snapshot.settings,
      platform: "darwin",
      engine: { state: "ready" },
      save: async () => true,
      goTo() {},
      onError: (error) => errors.push(error),
    }),
  );
  assert.ok(e.document.querySelector('input[aria-label="Full name"]'));
  assert.ok(e.document.querySelector('[data-setting="Local devices"]'));
  assert.equal(
    e.document.querySelector('[aria-label="Loading profile"]'),
    null,
  );
  assert.deepEqual(errors, []);
});
